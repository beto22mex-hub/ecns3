import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';
import https from 'https';
import * as db from './db.ts';
import { generateEcnSummary } from './services/geminiService.ts';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import dns from 'dns';
import * as XLSX from 'xlsx';
import { executeSapAutomationViaPowerShell, SapExtractedRecord } from './services/sapPowerShellService.ts';
dns.setDefaultResultOrder('ipv4first');
const { sql } = db;

async function startServer() {
    const app = express();
    const PORT = 8080;

    // --- Database Initialization ---
    try {
        await db.init();
        console.log(`[DB] Successfully connected to database.`);
    } catch (err: any) {
        console.error('[Server] CRITICAL: Could not connect to the database on startup. Exiting.', err);
        process.exit(1);
    }

    const distPath = path.join(process.cwd(), 'dist');
    const isProduction = (process.env.NODE_ENV === 'production' || !!process.env.K_SERVICE) && fs.existsSync(path.join(distPath, 'index.html'));

    app.use((req, res, next) => {
        console.log(`[Server] ${req.method} ${req.url}`);
        next();
    });
    app.use(cors());
    app.use(express.json({ limit: '50mb' }));

    // Fast health check
    app.get('/health', (req, res) => {
        res.status(200).send('OK');
    });

    // --- API ROUTES ---

    app.get('/api/users', async (req, res) => {
        try {
            const result = await db.pool.request().query('SELECT * FROM users ORDER BY name');
            res.json(result.recordset);
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.put('/api/users/:id', async (req, res) => {
        try {
            const user = req.body;
            await db.pool.request()
                .input('id', sql.NVarChar, req.params.id)
                .input('name', sql.NVarChar, user.name)
                .input('email', sql.NVarChar, user.email)
                .input('dept', sql.NVarChar, user.department)
                .input('photo', sql.NVarChar, user.photo || null)
                .query("UPDATE users SET name=@name, email=@email, department=@dept, photo=@photo WHERE id=@id");
            res.json({ message: 'User updated' });
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/ecns', async (req, res) => {
        try {
            const { search, status, year, timeFilter } = req.query;
            let query = `SELECT id, initiator, description, status, creation_date as creationDate, implementation_date as implementationDate, summary FROM ecns WHERE 1=1`;
            const request = db.pool.request();

            if (search) {
                request.input('search', sql.NVarChar, `%${search}%`);
                query += ` AND (id LIKE @search OR description LIKE @search OR initiator LIKE @search)`;
            }
            if (status && status !== 'Todos') {
                request.input('status', sql.NVarChar, status);
                query += ` AND status = @status`;
            }
            if (year && year !== 'all') {
                request.input('year', sql.Int, parseInt(year as string));
                query += ` AND YEAR(implementation_date) = @year`;
            }
            if (timeFilter) {
                if (timeFilter === 'last-30') {
                    query += ` AND implementation_date >= DATEADD(day, -30, GETDATE())`;
                } else if ((timeFilter as string).startsWith('next-')) {
                    const days = parseInt((timeFilter as string).split('-')[1]);
                    request.input('days', sql.Int, days);
                    query += ` AND implementation_date BETWEEN GETDATE() AND DATEADD(day, @days, GETDATE())`;
                }
            }

            const result = await request.query(query + " ORDER BY creation_date DESC");
            const ecns = result.recordset;

            if (ecns.length > 0) {
                const ids = ecns.map(e => `'${e.id}'`).join(',');
                const comps = await db.pool.request().query(`
                    SELECT id, ecn_id, assembly, old_component, new_component, 
                           old_subassembly, new_subassembly, sku, site 
                    FROM component_changes 
                    WHERE ecn_id IN (${ids})
                `);
                const map: any = {};
                comps.recordset.forEach(c => {
                    if (!map[c.ecn_id]) map[c.ecn_id] = { skus: new Set(), old: new Set(), new: new Set(), sites: new Set() };
                    if (c.sku) map[c.ecn_id].skus.add(c.sku);
                    // Usar subensambles si existen para la lista resumida
                    const oldVal = c.old_subassembly || c.old_component;
                    const newVal = c.new_subassembly || c.new_component;
                    if (oldVal) map[c.ecn_id].old.add(oldVal);
                    if (newVal) map[c.ecn_id].new.add(newVal);
                    if (c.site) map[c.ecn_id].sites.add(c.site);
                });
                ecns.forEach(e => {
                    e.skuList = map[e.id] ? Array.from(map[e.id].skus).join(', ') : '';
                    e.oldComponentList = map[e.id] ? Array.from(map[e.id].old).join(', ') : '';
                    e.newComponentList = map[e.id] ? Array.from(map[e.id].new).join(', ') : '';
                    e.siteList = map[e.id] ? Array.from(map[e.id].sites).join(', ') : '';
                });
            }
            res.json(ecns);
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/ecns/:id/notify-implemented', async (req, res) => {
        // Lógica para enviar correo de implementación
        res.json({ message: 'Notificación enviada' });
    });

    app.post('/api/ecns/:id/notify-status', async (req, res) => {
        // Lógica para enviar correo de cambio de estatus
        res.json({ message: 'Estatus notificado' });
    });

    app.get('/api/ecns/:id', async (req, res) => {
        try {
            const ecn = (await db.pool.request().input('id', sql.NVarChar, req.params.id).query("SELECT id, initiator, description, status, creation_date as creationDate, implementation_date as implementationDate, summary FROM ecns WHERE id=@id")).recordset[0];
            if (!ecn) return res.status(404).json({ error: 'Not found' });

            const changes = await db.pool.request().input('id', sql.NVarChar, req.params.id).query("SELECT * FROM component_changes WHERE ecn_id=@id");
            ecn.changes = changes.recordset.map(c => ({
                id: c.id,
                assembly: c.assembly,
                assemblyRevision: c.assembly_revision,
                assemblyDescription: c.assembly_description,
                oldComponent: c.old_component,
                newComponent: c.new_component,
                newComponentRevision: c.new_component_revision,
                newComponentDescription: c.new_component_description,
                oldSubassembly: c.old_subassembly,
                newSubassembly: c.new_subassembly,
                newSubassemblyRevision: c.new_subassembly_revision,
                newSubassemblyDescription: c.new_subassembly_description,
                sku: c.sku,
                family: c.family,
                demand: c.demand,
                onHandInventory: c.on_hand_inventory,
                openPoQty: c.open_po_qty,
                startDate: c.start_date,
                site: c.site
            }));

            ecn.notes = (await db.pool.request().input('id', sql.NVarChar, req.params.id).query("SELECT * FROM notes WHERE ecn_id=@id ORDER BY date DESC")).recordset;
            ecn.checklist = (await db.pool.request().input('id', sql.NVarChar, req.params.id).query("SELECT * FROM checklist_items WHERE ecn_id=@id")).recordset;
            res.json(ecn);
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/ecns/:id/generate-summary', async (req, res) => {
        try {
            const ecnId = req.params.id;
            const ecn = (await db.pool.request().input('id', sql.NVarChar, ecnId).query("SELECT id, initiator, description, status, creation_date as creationDate, implementation_date as implementationDate, summary FROM ecns WHERE id=@id")).recordset[0];
            if (!ecn) return res.status(404).json({ error: 'ECN not found' });

            const changes = await db.pool.request().input('id', sql.NVarChar, ecnId).query("SELECT * FROM component_changes WHERE ecn_id=@id");
            ecn.changes = changes.recordset.map(c => ({
                id: c.id,
                assembly: c.assembly,
                assemblyRevision: c.assembly_revision,
                assemblyDescription: c.assembly_description,
                oldComponent: c.old_component,
                newComponent: c.new_component,
                newComponentRevision: c.new_component_revision,
                newComponentDescription: c.new_component_description,
                oldSubassembly: c.old_subassembly,
                newSubassembly: c.new_subassembly,
                newSubassemblyRevision: c.new_subassembly_revision,
                newSubassemblyDescription: c.new_subassembly_description,
                sku: c.sku,
                family: c.family,
                demand: c.demand,
                onHandInventory: c.on_hand_inventory,
                openPoQty: c.open_po_qty,
                startDate: c.start_date,
                site: c.site
            }));

            const generatedSummaryObject = await generateEcnSummary(ecn);
            const summaryText = generatedSummaryObject.summary || ''; // Extract only the summary text

            // Auto-save summary to DB
            await db.pool.request()
                .input('id', sql.NVarChar, ecnId)
                .input('sum', sql.NVarChar, summaryText) // Use the extracted summary text
                .query("UPDATE ecns SET summary=@sum WHERE id=@id");

            res.json(generatedSummaryObject); // Return the full generated object to the frontend
        } catch (e: any) {
            console.error('[Summary API Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.put('/api/ecns/:id/summary', async (req, res) => {
        try {
            const { summary } = req.body;
            await db.pool.request()
                .input('id', sql.NVarChar, req.params.id)
                .input('sum', sql.NVarChar, summary)
                .query("UPDATE ecns SET summary=@sum WHERE id=@id");
            res.json({ message: 'Summary updated' });
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.put('/api/ecns/:id', async (req, res) => {
        try {
            const { ecn, user } = req.body;
            const initiator = ecn.initiator || 'Sistema';

            // Asegurar que el usuario iniciador existe
            const userCheck = await db.pool.request()
                .input('uid', sql.NVarChar, initiator)
                .query("SELECT id FROM users WHERE id = @uid");

            if (userCheck.recordset.length === 0) {
                await db.pool.request()
                    .input('uid', sql.NVarChar, initiator)
                    .input('name', sql.NVarChar, initiator)
                    .query("INSERT INTO users (id, name) VALUES (@uid, @name)");
            }

            await db.pool.request()
                .input('id', sql.NVarChar, req.params.id)
                .input('init', sql.NVarChar, initiator)
                .input('desc', sql.NVarChar, ecn.description)
                .input('stat', sql.NVarChar, ecn.status)
                .input('idat', sql.Date, ecn.implementationDate ? new Date(ecn.implementationDate) : null)
                .query("UPDATE ecns SET initiator=@init, description=@desc, status=@stat, implementation_date=@idat WHERE id=@id");

            // Guardar componentes (changes) incluyendo SKU y familia
            if (ecn.changes && Array.isArray(ecn.changes)) {
                // Obtener los IDs actuales en BD para este ECN
                const existingIds = (await db.pool.request()
                    .input('ecn_id', sql.NVarChar, req.params.id)
                    .query("SELECT id FROM component_changes WHERE ecn_id = @ecn_id"))
                    .recordset.map((r: any) => r.id);

                const incomingIds = ecn.changes
                    .filter((c: any) => c.id && !c.id.startsWith('new-'))
                    .map((c: any) => c.id);

                // Eliminar los que ya no están en la lista
                const toDelete = existingIds.filter((id: string) => !incomingIds.includes(id));
                for (const delId of toDelete) {
                    await db.pool.request()
                        .input('id', sql.NVarChar, delId)
                        .query("DELETE FROM component_changes WHERE id = @id");
                }

                // Insertar o actualizar cada componente
                for (const change of ecn.changes) {
                    const isNew = !change.id || change.id.startsWith('new-');

                    if (isNew) {
                        await db.pool.request()
                            .input('ecn_id', sql.NVarChar, req.params.id)
                            .input('assembly', sql.NVarChar, change.assembly || '')
                            .input('old_comp', sql.NVarChar, change.oldComponent || '')
                            .input('new_comp', sql.NVarChar, change.newComponent || '')
                            .input('sku', sql.NVarChar, change.sku || '')
                            .input('family', sql.NVarChar, change.family || '')
                            .input('demand', sql.Decimal(18, 2), change.demand || 0)
                            .input('on_hand', sql.Decimal(18, 2), change.onHandInventory || 0)
                            .input('open_po', sql.Decimal(18, 2), change.openPoQty || 0)
                            .input('sdate', sql.Date, change.startDate ? new Date(change.startDate) : null)
                            .input('site', sql.NVarChar, change.site || '5205')
                            .query(`
                                INSERT INTO component_changes (
                                    id, ecn_id, assembly, old_component, new_component,
                                    sku, family, demand, on_hand_inventory, open_po_qty, start_date, site
                                ) VALUES (
                                    NEWID(), @ecn_id, @assembly, @old_comp, @new_comp,
                                    @sku, @family, @demand, @on_hand, @open_po, @sdate, @site
                                )
                            `);
                    } else {
                        await db.pool.request()
                            .input('id', sql.NVarChar, change.id)
                            .input('assembly', sql.NVarChar, change.assembly || '')
                            .input('old_comp', sql.NVarChar, change.oldComponent || '')
                            .input('new_comp', sql.NVarChar, change.newComponent || '')
                            .input('sku', sql.NVarChar, change.sku || '')
                            .input('family', sql.NVarChar, change.family || '')
                            .input('demand', sql.Decimal(18, 2), change.demand || 0)
                            .input('on_hand', sql.Decimal(18, 2), change.onHandInventory || 0)
                            .input('open_po', sql.Decimal(18, 2), change.openPoQty || 0)
                            .input('sdate', sql.Date, change.startDate ? new Date(change.startDate) : null)
                            .input('site', sql.NVarChar, change.site || '5205')
                            .query(`
                                UPDATE component_changes SET
                                    assembly = @assembly,
                                    old_component = @old_comp,
                                    new_component = @new_comp,
                                    sku = @sku,
                                    family = @family,
                                    demand = @demand,
                                    on_hand_inventory = @on_hand,
                                    open_po_qty = @open_po,
                                    start_date = @sdate,
                                    site = @site
                                WHERE id = @id
                            `);
                    }
                }
            }

            res.json({ message: 'Updated' });
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });


    app.post('/api/ecns/:id/notes', async (req, res) => {
        try {
            await db.pool.request()
                .input('id', sql.UniqueIdentifier, uuidv4())
                .input('ecn', sql.NVarChar, req.params.id)
                .input('auth', sql.NVarChar, req.body.author)
                .input('txt', sql.NVarChar, req.body.text)
                .input('d', sql.DateTimeOffset, new Date())
                .query("INSERT INTO notes (id, ecn_id, author, text, date) VALUES (@id, @ecn, @auth, @txt, @d)");
            res.json({ message: 'Saved' });
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/import/sap-upsert', async (req, res) => {
        const { ecns, fileName } = req.body;
        if (!ecns || !Array.isArray(ecns)) {
            return res.status(400).json({ error: 'Invalid data format' });
        }

        const transaction = new sql.Transaction(db.pool);
        try {
            await transaction.begin();
            let newCount = 0;
            let updatedCount = 0;
            const newEcns = [];
            const updatedEcns = [];

            for (const ecn of ecns) {
                const initiator = ecn.initiator || 'Sistema';

                // Asegurar que el usuario iniciador existe para evitar conflictos de clave foránea
                const userCheck = await transaction.request()
                    .input('uid', sql.NVarChar, initiator)
                    .query("SELECT id FROM users WHERE id = @uid");

                if (userCheck.recordset.length === 0) {
                    await transaction.request()
                        .input('uid', sql.NVarChar, initiator)
                        .input('name', sql.NVarChar, initiator)
                        .query("INSERT INTO users (id, name) VALUES (@uid, @name)");
                }

                const request = transaction.request();
                request.input('id', sql.NVarChar, ecn.id);

                const existing = await request.query("SELECT id FROM ecns WHERE id = @id");
                const isUpdate = existing.recordset.length > 0;

                request.input('init', sql.NVarChar, initiator);
                request.input('desc', sql.NVarChar, ecn.description || '');
                request.input('stat', sql.NVarChar, ecn.status);
                request.input('cdat', sql.Date, ecn.creationDate ? new Date(ecn.creationDate) : new Date());
                request.input('idat', sql.Date, ecn.implementationDate ? new Date(ecn.implementationDate) : null);

                if (isUpdate) {
                    await request.query(`
                        UPDATE ecns SET 
                            initiator = @init, 
                            description = @desc, 
                            status = @stat, 
                            implementation_date = @idat 
                        WHERE id = @id
                    `);
                    updatedCount++;
                    updatedEcns.push(ecn.id);
                } else {
                    await request.query(`
                        INSERT INTO ecns (id, initiator, description, status, creation_date, implementation_date)
                        VALUES (@id, @init, @desc, @stat, @cdat, @idat)
                    `);
                    newCount++;
                    newEcns.push(ecn.id);
                }

                if (ecn.changes && ecn.changes.length > 0) {
                    for (const change of ecn.changes) {
                        const cReq = transaction.request();
                        cReq.input('ecn_id', sql.NVarChar, ecn.id);
                        cReq.input('assembly', sql.NVarChar, change.assembly || '');
                        cReq.input('assembly_rev', sql.NVarChar, change.assemblyRevision || '');
                        cReq.input('assembly_desc', sql.NVarChar, change.assemblyDescription || '');
                        cReq.input('old_comp', sql.NVarChar, change.oldComponent || '');
                        cReq.input('new_comp', sql.NVarChar, change.newComponent || '');
                        cReq.input('new_comp_rev', sql.NVarChar, change.newComponentRevision || '');
                        cReq.input('new_comp_desc', sql.NVarChar, change.newComponentDescription || '');
                        cReq.input('old_sub', sql.NVarChar, change.oldSubassembly || '');
                        cReq.input('new_sub', sql.NVarChar, change.newSubassembly || '');
                        cReq.input('new_sub_rev', sql.NVarChar, change.newSubassemblyRevision || '');
                        cReq.input('new_sub_desc', sql.NVarChar, change.newSubassemblyDescription || '');
                        cReq.input('sku', sql.NVarChar, change.sku || '');
                        cReq.input('family', sql.NVarChar, change.family || '');
                        cReq.input('demand', sql.Decimal(18, 2), change.demand || 0);
                        cReq.input('on_hand', sql.Decimal(18, 2), change.onHandInventory || 0);
                        cReq.input('open_po', sql.Decimal(18, 2), change.openPoQty || 0);
                        cReq.input('sdate', sql.Date, change.startDate ? new Date(change.startDate) : null);
                        cReq.input('site', sql.NVarChar, change.site || '5205');

                        const existingComp = await cReq.query(`
                            SELECT id FROM component_changes 
                            WHERE ecn_id = @ecn_id 
                            AND assembly = @assembly 
                            AND old_component = @old_comp 
                            AND new_component = @new_comp
                            AND old_subassembly = @old_sub
                            AND new_subassembly = @new_sub
                            AND site = @site
                        `);

                        if (existingComp.recordset.length > 0) {
                            const compId = existingComp.recordset[0].id;
                            const uReq = transaction.request();
                            uReq.input('comp_id', sql.UniqueIdentifier, compId);
                            uReq.input('assembly_rev', sql.NVarChar, change.assemblyRevision || '');
                            uReq.input('assembly_desc', sql.NVarChar, change.assemblyDescription || '');
                            uReq.input('new_comp_rev', sql.NVarChar, change.newComponentRevision || '');
                            uReq.input('new_comp_desc', sql.NVarChar, change.newComponentDescription || '');
                            uReq.input('new_sub_rev', sql.NVarChar, change.newSubassemblyRevision || '');
                            uReq.input('new_sub_desc', sql.NVarChar, change.newSubassemblyDescription || '');
                            uReq.input('sku', sql.NVarChar, change.sku || '');
                            uReq.input('family', sql.NVarChar, change.family || '');
                            uReq.input('demand', sql.Decimal(18, 2), change.demand || 0);
                            uReq.input('on_hand', sql.Decimal(18, 2), change.onHandInventory || 0);
                            uReq.input('open_po', sql.Decimal(18, 2), change.openPoQty || 0);
                            uReq.input('sdate', sql.Date, change.startDate ? new Date(change.startDate) : null);

                            await uReq.query(`
                                UPDATE component_changes SET
                                    assembly_revision = @assembly_rev,
                                    assembly_description = @assembly_desc,
                                    new_component_revision = @new_comp_rev,
                                    new_component_description = @new_comp_desc,
                                    new_subassembly_revision = @new_sub_rev,
                                    new_subassembly_description = @new_sub_desc,
                                    sku = COALESCE(NULLIF(@sku, ''), sku),
                                    family = COALESCE(NULLIF(@family, ''), family),
                                    demand = @demand,
                                    on_hand_inventory = @on_hand,
                                    open_po_qty = @open_po,
                                    start_date = @sdate
                                WHERE id = @comp_id
                            `);
                        } else {
                            await cReq.query(`
                                INSERT INTO component_changes (
                                    id, ecn_id, assembly, assembly_revision, assembly_description,
                                    old_component, new_component, new_component_revision, new_component_description,
                                    old_subassembly, new_subassembly, new_subassembly_revision, new_subassembly_description,
                                    sku, family, demand, on_hand_inventory, open_po_qty, start_date, site
                                ) VALUES (
                                    NEWID(), @ecn_id, @assembly, @assembly_rev, @assembly_desc,
                                    @old_comp, @new_comp, @new_comp_rev, @new_comp_desc,
                                    @old_sub, @new_sub, @new_sub_rev, @new_sub_desc,
                                    @sku, @family, @demand, @on_hand, @open_po, @sdate, @site
                                )
                            `);
                        }
                    }
                }

                if (ecn.notes && ecn.notes.length > 0) {
                    for (const note of ecn.notes) {
                        if (!note.text || !note.text.trim()) continue;
                        const noteTxt = note.text.trim();
                        const noteCheck = await transaction.request()
                            .input('ecn_id', sql.NVarChar, ecn.id)
                            .input('txt', sql.NVarChar, noteTxt)
                            .query("SELECT id FROM notes WHERE ecn_id = @ecn_id AND text = @txt");

                        if (noteCheck.recordset.length === 0) {
                            const nReq = transaction.request();
                            nReq.input('nid', sql.UniqueIdentifier, uuidv4());
                            nReq.input('ecn_id', sql.NVarChar, ecn.id);
                            nReq.input('author', sql.NVarChar, note.author || initiator);
                            nReq.input('txt', sql.NVarChar, noteTxt);
                            nReq.input('ndate', sql.DateTimeOffset, note.date ? new Date(note.date) : new Date());
                            await nReq.query(`
                                INSERT INTO notes (id, ecn_id, author, text, date)
                                VALUES (@nid, @ecn_id, @author, @txt, @ndate)
                            `);
                        }
                    }
                }
            }

            const logReq = transaction.request();
            logReq.input('ts', sql.DateTimeOffset, new Date());
            logReq.input('file', sql.NVarChar, fileName || 'Manual');
            logReq.input('total', sql.Int, ecns.length);
            logReq.input('new_ecns', sql.NVarChar, newEcns.slice(0, 10).join(', ') + (newEcns.length > 10 ? '...' : ''));
            logReq.input('upd_ecns', sql.NVarChar, updatedEcns.slice(0, 10).join(', ') + (updatedEcns.length > 10 ? '...' : ''));
            logReq.input('details', sql.NVarChar, `Importación exitosa de ${fileName || 'Manual'}. Nuevos: ${newCount}, Actualizados: ${updatedCount}`);

            await logReq.query(`
                INSERT INTO import_logs (timestamp, file_name, total_records, new_ecns, updated_ecns, details)
                VALUES (@ts, @file, @total, @new_ecns, @upd_ecns, @details)
            `);

            // Also add to audit_log for visibility in the UI
            await transaction.request()
                .input('aid', sql.UniqueIdentifier, uuidv4())
                .input('uts', sql.DateTimeOffset, new Date())
                .input('uuser', sql.NVarChar, 'Sistema')
                .input('utype', sql.NVarChar, 'Importación')
                .input('utarget', sql.NVarChar, fileName || 'SAP Report')
                .input('uact', sql.NVarChar, `Importación SAP: ${fileName || 'Manual'}. ${newCount} nuevos, ${updatedCount} actualizados.`)
                .query("INSERT INTO audit_log (id, timestamp, [user], type, target, action) VALUES (@aid, @uts, @uuser, @utype, @utarget, @uact)");

            await transaction.commit();
            res.json({ success: true, newCount, updatedCount });
        } catch (e: any) {
            console.error('SAP Upsert error:', e);
            try {
                if (transaction) {
                    await transaction.rollback();
                }
            } catch (rbErr) {
                console.error('Rollback error (ignored):', (rbErr as Error).message);
            }
            res.status(500).json({ error: e.message });
        }
    });



    // --- SAP Direct PowerShell Middleware API Routes ---
    app.get('/api/sap/status', async (req, res) => {
        try {
            res.json({
                status: 'online',
                platform: process.platform,
                powershellAvailable: true,
                middleware: 'node-powershell',
                description: 'SAP GUI Scripting Engine Bridge for Direct ECN/SAP Sync'
            });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/sap/execute-sync', async (req, res) => {
        try {
            const { startDate, endDate, plant } = req.body as { startDate?: string; endDate?: string; plant?: string };
            const requestedPlant = (plant || '5205').trim();

            // Validate plant 5201 if MXOH is not enabled
            if (requestedPlant === '5201') {
                const mxohSetting = await db.pool.request()
                    .input('key', sql.NVarChar, 'mxoh_plant_5201_enabled')
                    .query('SELECT value FROM settings WHERE [key] = @key');
                const mxohValue = mxohSetting.recordset[0]?.value || '';
                if (mxohValue.toLowerCase() !== 'true' && mxohValue.toLowerCase() !== '1') {
                    return res.status(403).json({ error: 'La Planta 5201 está deshabilitada. Para habilitarla, active la opción MXOH en la configuración.' });
                }
            }

            // Read optional SAP system name from settings
            let sapSystemName = 'BRP';
            try {
                const sapSetting = await db.pool.request()
                    .input('key', sql.NVarChar, 'sap_system_name')
                    .query('SELECT value FROM settings WHERE [key] = @key');
                const val = sapSetting.recordset[0]?.value;
                if (val && typeof val === 'string' && val.trim().length > 0) sapSystemName = val.trim();
            } catch (e) {
                console.warn('[SAP] No se pudo leer setting sap_system_name, usando BRP por defecto.');
            }

            // Execute SAP GUI Automation via node-powershell middleware layer
            const executionResult = await executeSapAutomationViaPowerShell({
                startDate,
                endDate,
                plant: requestedPlant,
                autoImport: true,
                sapSystemName
            });

            // If SAP GUI is open but no user session active, return 412 with a specific code
            if (executionResult && executionResult.comDetected && !executionResult.sessionActive) {
                return res.status(412).json({
                    error: 'SAP GUI detectado pero no hay sesión activa. Por favor inicie sesión en SAP y reintente.',
                    reason: 'sap_no_session',
                    logs: executionResult.logs || []
                });
            }

            const records = executionResult.records || [];
            let skippedPlant5201Count = 0;

            // Filter out 5201 if requestedPlant was not explicitly 5201
            const filteredRecords = records.filter(r => {
                const rowPlant = String(r.plant || requestedPlant).trim();
                if (rowPlant === '5201' && requestedPlant !== '5201') {
                    skippedPlant5201Count++;
                    return false;
                }
                return true;
            });

            // Upsert directly into Database without Excel file
            const transaction = new sql.Transaction(db.pool);
            await transaction.begin();
            let newCount = 0;
            let updatedCount = 0;

            try {
                for (const rec of filteredRecords) {
                    const ecnId = rec.ecnNumber;
                    if (!ecnId) continue;

                    const initiator = rec.initiator || 'SAP GUI Scripting Engine';
                    const userCheck = await transaction.request()
                        .input('uid', sql.NVarChar, initiator)
                        .query("SELECT id FROM users WHERE id = @uid");
                    if (userCheck.recordset.length === 0) {
                        await transaction.request()
                            .input('uid', sql.NVarChar, initiator)
                            .input('name', sql.NVarChar, initiator)
                            .query("INSERT INTO users (id, name) VALUES (@uid, @name)");
                    }

                    const request = transaction.request();
                    request.input('id', sql.NVarChar, ecnId);
                    const existing = await request.query("SELECT id FROM ecns WHERE id = @id");
                    const isUpdate = existing.recordset.length > 0;

                    request.input('init', sql.NVarChar, initiator);
                    request.input('desc', sql.NVarChar, rec.description || `ECN ${ecnId} extraído desde SAP`);
                    request.input('stat', sql.NVarChar, 'Pendiente');
                    request.input('cdat', sql.Date, rec.creationDate ? new Date(rec.creationDate) : new Date());
                    request.input('idat', sql.Date, rec.implementationDate ? new Date(rec.implementationDate) : null);

                    if (isUpdate) {
                        await request.query("UPDATE ecns SET initiator=@init, description=@desc, status=@stat, implementation_date=@idat WHERE id=@id");
                        updatedCount++;
                    } else {
                        await request.query("INSERT INTO ecns (id, initiator, description, status, creation_date, implementation_date) VALUES (@id, @init, @desc, @stat, @cdat, @idat)");
                        newCount++;
                    }

                    // Insert or update component change
                    const cReq = transaction.request();
                    cReq.input('ecn_id', sql.NVarChar, ecnId);
                    cReq.input('assembly', sql.NVarChar, rec.assembly || '');
                    cReq.input('assembly_rev', sql.NVarChar, rec.assemblyRevision || '');
                    cReq.input('assembly_desc', sql.NVarChar, rec.assemblyDescription || rec.description || '');
                    cReq.input('old_comp', sql.NVarChar, rec.oldComponent || '');
                    cReq.input('new_comp', sql.NVarChar, rec.newComponent || '');
                    cReq.input('new_comp_rev', sql.NVarChar, rec.newComponentRevision || '');
                    cReq.input('new_comp_desc', sql.NVarChar, rec.newComponentDescription || '');
                    cReq.input('old_sub', sql.NVarChar, rec.oldSubassembly || '');
                    cReq.input('new_sub', sql.NVarChar, rec.newSubassembly || '');
                    cReq.input('new_sub_rev', sql.NVarChar, rec.newSubassemblyRevision || '');
                    cReq.input('new_sub_desc', sql.NVarChar, rec.newSubassemblyDescription || '');
                    cReq.input('sku', sql.NVarChar, rec.topSku || rec.sku || '');
                    cReq.input('family', sql.NVarChar, rec.family || 'VESDA');
                    cReq.input('demand', sql.Decimal(18, 2), rec.demand || 0);
                    cReq.input('on_hand', sql.Decimal(18, 2), rec.onHandInventory || 0);
                    cReq.input('open_po', sql.Decimal(18, 2), rec.openPoQty || 0);
                    cReq.input('sdate', sql.Date, rec.startDate ? new Date(rec.startDate) : new Date());
                    cReq.input('site', sql.NVarChar, rec.plant || requestedPlant);

                    const existingComp = await cReq.query(`
                        SELECT id FROM component_changes 
                        WHERE ecn_id = @ecn_id AND assembly = @assembly AND old_component = @old_comp AND new_component = @new_comp AND site = @site
                    `);

                    if (existingComp.recordset.length > 0) {
                        const compId = existingComp.recordset[0].id;
                        const uReq = transaction.request();
                        uReq.input('comp_id', sql.UniqueIdentifier, compId);
                        uReq.input('assembly_rev', sql.NVarChar, rec.assemblyRevision || '');
                        uReq.input('assembly_desc', sql.NVarChar, rec.assemblyDescription || rec.description || '');
                        uReq.input('new_comp_rev', sql.NVarChar, rec.newComponentRevision || '');
                        uReq.input('new_comp_desc', sql.NVarChar, rec.newComponentDescription || '');
                        uReq.input('sku', sql.NVarChar, rec.topSku || rec.sku || '');
                        uReq.input('family', sql.NVarChar, rec.family || 'VESDA');
                        uReq.input('demand', sql.Decimal(18, 2), rec.demand || 0);
                        uReq.input('on_hand', sql.Decimal(18, 2), rec.onHandInventory || 0);
                        uReq.input('open_po', sql.Decimal(18, 2), rec.openPoQty || 0);
                        uReq.input('sdate', sql.Date, rec.startDate ? new Date(rec.startDate) : new Date());

                        await uReq.query(`
                            UPDATE component_changes SET
                                assembly_revision = @assembly_rev,
                                assembly_description = @assembly_desc,
                                new_component_revision = @new_comp_rev,
                                new_component_description = @new_comp_desc,
                                sku = @sku,
                                family = @family,
                                demand = @demand,
                                on_hand_inventory = @on_hand,
                                open_po_qty = @open_po,
                                start_date = @sdate
                            WHERE id = @comp_id
                        `);
                    } else {
                        await cReq.query(`
                            INSERT INTO component_changes (
                                id, ecn_id, assembly, assembly_revision, assembly_description,
                                old_component, new_component, new_component_revision, new_component_description,
                                old_subassembly, new_subassembly, new_subassembly_revision, new_subassembly_description,
                                sku, family, demand, on_hand_inventory, open_po_qty, start_date, site
                            ) VALUES (
                                NEWID(), @ecn_id, @assembly, @assembly_rev, @assembly_desc,
                                @old_comp, @new_comp, @new_comp_rev, @new_comp_desc,
                                @old_sub, @new_sub, @new_sub_rev, @new_sub_desc,
                                @sku, @family, @demand, @on_hand, @open_po, @sdate, @site
                            )
                        `);
                    }

                    if (rec.comments) {
                        const noteTxt = rec.comments.trim();
                        const noteCheck = await transaction.request()
                            .input('ecn_id', sql.NVarChar, ecnId)
                            .input('txt', sql.NVarChar, noteTxt)
                            .query("SELECT id FROM notes WHERE ecn_id = @ecn_id AND text = @txt");

                        if (noteCheck.recordset.length === 0) {
                            const nReq = transaction.request();
                            nReq.input('nid', sql.UniqueIdentifier, uuidv4());
                            nReq.input('ecn_id', sql.NVarChar, ecnId);
                            nReq.input('author', sql.NVarChar, initiator);
                            nReq.input('txt', sql.NVarChar, noteTxt);
                            nReq.input('ndate', sql.DateTimeOffset, new Date());
                            await nReq.query("INSERT INTO notes (id, ecn_id, author, text, date) VALUES (@nid, @ecn_id, @author, @txt, @ndate)");
                        }
                    }
                }

                // Log to import_logs
                await transaction.request()
                    .input('ts', sql.DateTimeOffset, new Date())
                    .input('file', sql.NVarChar, `SAP GUI PowerShell Middleware (${requestedPlant})`)
                    .input('total', sql.Int, filteredRecords.length)
                    .input('new_ecns', sql.NVarChar, `${newCount} nuevos`)
                    .input('upd_ecns', sql.NVarChar, `${updatedCount} actualizados`)
                    .input('details', sql.NVarChar, `Sincronización directa SAP ejecutada vía node-powershell para planta ${requestedPlant}. Nuevos: ${newCount}, Actualizados: ${updatedCount}. Ignorados 5201: ${skippedPlant5201Count}`)
                    .query("INSERT INTO import_logs (timestamp, file_name, total_records, new_ecns, updated_ecns, details) VALUES (@ts, @file, @total, @new_ecns, @upd_ecns, @details)");

                // Log to audit_log
                await transaction.request()
                    .input('aid', sql.UniqueIdentifier, uuidv4())
                    .input('uts', sql.DateTimeOffset, new Date())
                    .input('uuser', sql.NVarChar, 'SAP PowerShell Bridge')
                    .input('utype', sql.NVarChar, 'Sincronización Directa')
                    .input('utarget', sql.NVarChar, `Planta ${requestedPlant}`)
                    .input('uact', sql.NVarChar, `Extracción directa SAP PowerShell completada: ${newCount} nuevos, ${updatedCount} actualizados.`)
                    .query("INSERT INTO audit_log (id, timestamp, [user], type, target, action) VALUES (@aid, @uts, @uuser, @utype, @utarget, @uact)");

                await transaction.commit();
            } catch (txErr: any) {
                if (transaction) await transaction.rollback();
                throw txErr;
            }

            res.json({
                success: true,
                message: `Sincronización directa SAP (node-powershell) completada: ${newCount} nuevos, ${updatedCount} actualizados.`,
                mode: executionResult.mode,
                newCount,
                updatedCount,
                totalRecords: filteredRecords.length,
                skipped5201: skippedPlant5201Count,
                logs: executionResult.logs
            });
        } catch (e: any) {
            console.error('[SAP PowerShell Sync Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/import/vba-sync', async (req, res) => {
        try {
            const { startDate, endDate, plant } = req.body as { startDate?: string; endDate?: string; plant?: string };
            const requestedPlant = (plant || '5205').trim();

            // Block plant 5201 unless MXOH setting is enabled
            if (requestedPlant === '5201') {
                const mxohSetting = await db.pool.request()
                    .input('key', sql.NVarChar, 'mxoh_plant_5201_enabled')
                    .query('SELECT value FROM settings WHERE [key] = @key');
                const mxohValue = mxohSetting.recordset[0]?.value || '';
                if (mxohValue.toLowerCase() !== 'true' && mxohValue.toLowerCase() !== '1') {
                    return res.status(403).json({ error: 'La Planta 5201 está deshabilitada. Para habilitarla, active la opción MXOH en la configuración.' });
                }
            }

            // Parse optional date filter
            const filterStart = startDate ? new Date(startDate) : null;
            const filterEnd = endDate ? new Date(endDate) : null;

            // --- Step 1: Run VBScript to trigger SAP macro and generate Output file ---
            const vbsPath = path.join(process.cwd(), 'static', 'run_ecn_macro.vbs');
            const xlsmPath = 'C:\\Personal\\ECN_automation.xlsm';

            if (!fs.existsSync(vbsPath)) {
                return res.status(500).json({ error: `No se encontró el script de automatización en: ${vbsPath}` });
            }
            if (!fs.existsSync(xlsmPath)) {
                return res.status(500).json({ error: `No se encontró el archivo de macros SAP en: ${xlsmPath}` });
            }

            console.log('[VBA-Sync] Ejecutando macro SAP via VBScript...');
            await new Promise<void>((resolve, reject) => {
                execFile('cscript', ['//NoLogo', vbsPath, requestedPlant, startDate || '', endDate || ''],
                    { timeout: 10 * 60 * 1000 }, // 10 min timeout
                    (err, stdout, stderr) => {
                        if (stdout) console.log('[VBA-Sync] VBS output:', stdout.trim());
                        if (stderr) console.warn('[VBA-Sync] VBS stderr:', stderr.trim());
                        if (err) {
                            console.error('[VBA-Sync] VBScript error:', err.message);
                            reject(new Error(`Error al ejecutar las macros de SAP: ${stdout || err.message}`));
                        } else if (stdout && stdout.includes('ERROR:')) {
                            reject(new Error(`Error en macro Excel/SAP: ${stdout.trim()}`));
                        } else {
                            console.log('[VBA-Sync] Macro SAP completada exitosamente.');
                            resolve();
                        }
                    }
                );
            });

            // --- Step 2: Find the generated Output file ---
            const searchDirs = [
                process.cwd(),
                'C:\\Personal',
                path.join(process.env.USERPROFILE || 'C:\\Users\\H583623', 'Downloads'),
                path.join(process.cwd(), '..')
            ];

            let targetFilePath: string | null = null;
            for (const dir of searchDirs) {
                if (!fs.existsSync(dir)) continue;
                const files = fs.readdirSync(dir);
                const candidate = files.find(f => {
                    const l = f.toLowerCase();
                    return (l === 'output.xlsx' || l.startsWith('ecn-') || l.startsWith('ecn') || l.includes('output')) && (l.endsWith('.xlsx') || l.endsWith('.xls'));
                });
                if (candidate) {
                    targetFilePath = path.join(dir, candidate);
                    break;
                }
            }

            if (!targetFilePath && fs.existsSync(process.cwd())) {
                const rootFiles = fs.readdirSync(process.cwd());
                const anyXlsx = rootFiles.find(f => f.toLowerCase().endsWith('.xlsx') || f.toLowerCase().endsWith('.xls'));
                if (anyXlsx) targetFilePath = path.join(process.cwd(), anyXlsx);
            }

            if (!targetFilePath) {
                return res.status(404).json({
                    error: 'La macro se ejecutó pero no se encontró el archivo de salida generado (Output.xlsx). Verifique que la macro guarde el archivo en C:\\Personal o en la carpeta del servidor.'
                });
            }

            const fileBuffer = fs.readFileSync(targetFilePath);
            const workbook = XLSX.read(fileBuffer, { cellDates: true });

            const outputSheetName = workbook.SheetNames.find(s => s.trim().toLowerCase() === 'output');
            let consolidatedRows: any[] = [];

            if (outputSheetName) {
                const worksheet = workbook.Sheets[outputSheetName];
                const allRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null }) as any[][];

                let headerRowIndex = 0;
                const keyHeaders = ['ecn', 'ecno', 'change no.', 'assembly', 'start material', 'component', 'plant', 'created by'];
                for (let i = 0; i < Math.min(15, allRows.length); i++) {
                    const rowValues = (allRows[i] || []).map(v => String(v || '').trim().toLowerCase());
                    if (keyHeaders.filter(kh => rowValues.includes(kh)).length >= 2) {
                        headerRowIndex = i;
                        break;
                    }
                }

                const rawHeaders = (allRows[headerRowIndex] || []).map(h => String(h || '').trim());
                const parsedHeaders: string[] = [];
                const headerCounts: Record<string, number> = {};
                rawHeaders.forEach(header => {
                    if (!header) return;
                    if (headerCounts[header]) {
                        headerCounts[header]++;
                        parsedHeaders.push(`${header}_${headerCounts[header]}`);
                    } else {
                        headerCounts[header] = 1;
                        parsedHeaders.push(header);
                    }
                });

                const rawData = allRows.slice(headerRowIndex + 1);
                consolidatedRows = rawData.map(row => {
                    const obj: any = {};
                    parsedHeaders.forEach((h, idx) => { obj[h] = row[idx]; });
                    return obj;
                });
            } else {
                const skuMap = new Map<string, { sku: string, family: string }>();
                const descMap = new Map<string, string>();

                const skuSheetName = workbook.SheetNames.find(s =>
                    s.trim().toLowerCase().includes('sku') ||
                    s.trim().toLowerCase().includes('description') ||
                    s.trim().toLowerCase().includes('familia')
                );

                if (skuSheetName) {
                    const skuSheet = workbook.Sheets[skuSheetName];
                    const skuJson = XLSX.utils.sheet_to_json(skuSheet) as any[];
                    skuJson.forEach(r => {
                        const assy = String(r.Assembly || r.assembly || r.Ensamble || '').trim();
                        const sku = String(r.SKU || r.sku || '').trim();
                        const fam = String(r.Family || r.family || r.Familia || '').trim();
                        if (assy && (sku || fam)) skuMap.set(assy, { sku, family: fam });
                        const ecnVal = String(r.ECRO || r.ECN || r.ecn || '').trim();
                        const descVal = String(r.Description || r.description || r.Descripción || '').trim();
                        if (ecnVal && descVal) descMap.set(ecnVal, descVal);
                    });
                }

                const mainSheetName = workbook.SheetNames.find(s =>
                    s.trim().toLowerCase().includes('sap data') ||
                    s.trim().toLowerCase().includes('ecn') ||
                    s.trim().toLowerCase() === 'sheet1'
                ) || workbook.SheetNames[0];

                const mainSheet = workbook.Sheets[mainSheetName];
                const allRows = XLSX.utils.sheet_to_json(mainSheet, { header: 1, defval: null }) as any[][];

                let headerRowIndex = 0;
                const keyHeaders = ['ecn', 'ecno', 'change no.', 'assembly', 'start material', 'component', 'plant', 'created by'];
                for (let i = 0; i < Math.min(15, allRows.length); i++) {
                    const rowValues = (allRows[i] || []).map(v => String(v || '').trim().toLowerCase());
                    if (keyHeaders.filter(kh => rowValues.includes(kh)).length >= 2) {
                        headerRowIndex = i;
                        break;
                    }
                }

                const rawHeaders = (allRows[headerRowIndex] || []).map(h => String(h || '').trim());
                const parsedHeaders: string[] = [];
                const headerCounts: Record<string, number> = {};
                rawHeaders.forEach(header => {
                    if (!header) return;
                    if (headerCounts[header]) {
                        headerCounts[header]++;
                        parsedHeaders.push(`${header}_${headerCounts[header]}`);
                    } else {
                        headerCounts[header] = 1;
                        parsedHeaders.push(header);
                    }
                });

                const rawData = allRows.slice(headerRowIndex + 1);
                consolidatedRows = rawData.map(row => {
                    const obj: any = {};
                    parsedHeaders.forEach((h, idx) => { obj[h] = row[idx]; });
                    const assyKey = String(obj['Assembly'] || obj['assembly'] || '').trim();
                    if (assyKey && skuMap.has(assyKey)) {
                        const m = skuMap.get(assyKey)!;
                        if (!obj['SKU'] && !obj['sku']) obj['SKU'] = m.sku;
                        if (!obj['Family'] && !obj['family']) obj['Family'] = m.family;
                    }
                    const ecnKey = String(obj['ECNO'] || obj['ECN'] || obj['ecn'] || '').trim();
                    if (ecnKey && descMap.has(ecnKey) && (!obj['Description'] || !obj['description'])) {
                        obj['Description'] = descMap.get(ecnKey);
                    }
                    return obj;
                });
            }

            const parseDateServer = (dateInput: any): string | null => {
                if (!dateInput) return null;
                if (dateInput instanceof Date && !isNaN(dateInput.getTime())) return dateInput.toISOString().split('T')[0];
                if (typeof dateInput === 'number' && dateInput > 1) {
                    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                    const date = new Date(excelEpoch.getTime() + dateInput * 24 * 60 * 60 * 1000);
                    if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
                }
                if (typeof dateInput === 'string') {
                    const trimmedDate = dateInput.trim().split(' ')[0];
                    let parts = trimmedDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
                    if (parts) return `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`;
                    parts = trimmedDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                    if (parts) return `${parts[3]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
                }
                return null;
            };

            const existingEcnsResult = await db.pool.request().query("SELECT id, initiator, description, status, creation_date as creationDate, implementation_date as implementationDate FROM ecns");
            const existingEcnsMap = new Map<string, any>(existingEcnsResult.recordset.map((e: any) => [e.id, e]));

            const ecnsToUpsertMap = new Map<string, any>();
            const todayStr = new Date().toISOString().split('T')[0];
            let skippedPlant5201Count = 0;

            for (const row of consolidatedRows) {
                const plantHeaderKey = Object.keys(row).find(k => k.toLowerCase().includes('plant') || k.toLowerCase().includes('planta'));
                const rowPlantVal = plantHeaderKey && row[plantHeaderKey] ? String(row[plantHeaderKey]).trim() : '';

                // Always skip plant 5201 (unless it's the explicitly requested plant and MXOH is enabled - already checked above)
                if (rowPlantVal === '5201' && requestedPlant !== '5201') {
                    skippedPlant5201Count++;
                    continue;
                }

                // Filter by requested plant if a plant column exists
                if (rowPlantVal && requestedPlant !== rowPlantVal) {
                    continue;
                }

                const ecnId = String(row.ECNO || row.ECN || row.ecn || row['Change No.'] || row['change no.'] || '').trim();
                if (!ecnId) continue;

                const assembly = String(row.Assembly || row.assembly || '').trim();
                const oldComponent = String(row.Component || row.component || row.OldComponent || '').trim();
                const newComponent = String(row['Start Material'] || row.newComponent || row.material || '').trim();

                let ecn = ecnsToUpsertMap.get(ecnId);
                let isNewEcn = false;
                if (!ecn) {
                    const existing = existingEcnsMap.get(ecnId);
                    if (existing) {
                        ecn = JSON.parse(JSON.stringify(existing));
                        if (!ecn.changes) ecn.changes = [];
                        if (!ecn.notes) ecn.notes = [];
                    } else {
                        isNewEcn = true;
                        ecn = {
                            id: ecnId,
                            initiator: String(row['Created by'] || row.createdBy || row.initiator || 'Sistema'),
                            description: String(row.Description || row.description || row.AssemblyDescription || `ECN importado ${ecnId}`),
                            status: 'Pendiente',
                            creationDate: parseDateServer(row['Created On'] || row.createdOn) || todayStr,
                            implementationDate: '',
                            changes: [], notes: []
                        };
                    }
                }

                const noteText = String(row.Notes || row.notes || row.Notas || '').trim();
                let noteAdded = false;
                if (noteText) {
                    if (!ecn.notes) ecn.notes = [];
                    if (!ecn.notes.some((n: any) => n.text === noteText)) {
                        ecn.notes.push({
                            id: uuidv4(),
                            author: String(row['Created by'] || row.createdBy || 'Sistema'),
                            text: noteText,
                            date: todayStr
                        });
                        noteAdded = true;
                    }
                }

                const rowStartDateStr = parseDateServer(row['Start date'] || row.startDate || row['Valid From']);
                if (!rowStartDateStr) continue;

                // Apply date range filter if provided
                if (filterStart || filterEnd) {
                    const rowDate = new Date(rowStartDateStr);
                    if (filterStart && rowDate < filterStart) continue;
                    if (filterEnd && rowDate > filterEnd) continue;
                }

                const startDate = rowStartDateStr;
                const newDemand = Number(row.Demand || row.demand) || 0;
                const newOnHand = Number(row['On hand inventory'] || row.onHandInventory) || 0;
                const newOpenPo = Number(row['Open PO Qty'] || row.openPoQty) || 0;
                const skuVal = String(row.SKU || row.sku || '').trim() || undefined;
                const familyVal = String(row.Family || row.family || row.Familia || '').trim() || undefined;
                const siteVal = rowPlantVal || requestedPlant;

                const newChangeValues: any = {
                    id: '',
                    assembly,
                    oldComponent,
                    newComponent,
                    startDate,
                    demand: newDemand,
                    onHandInventory: newOnHand,
                    openPoQty: newOpenPo,
                    assemblyDescription: String(row.Description || row.assemblyDescription || ''),
                    newComponentDescription: String(row['Material Description'] || row.startMaterialDescription || ''),
                    newComponentRevision: String(row['Rev No1'] || row.startMaterialRevision || ''),
                    assemblyRevision: String(row['Rev No'] || row.assemblyRevision || ''),
                    sku: skuVal,
                    family: familyVal,
                    site: siteVal
                };

                const existingChangeIndex = ecn.changes.findIndex((c: any) =>
                    c.assembly === newChangeValues.assembly &&
                    c.oldComponent === newChangeValues.oldComponent &&
                    c.newComponent === newChangeValues.newComponent &&
                    c.site === newChangeValues.site
                );

                let componentChanged = false;
                if (existingChangeIndex > -1) {
                    const existingChange = ecn.changes[existingChangeIndex];
                    const existDate = existingChange.startDate ? existingChange.startDate.split('T')[0] : '';
                    const newDate = newChangeValues.startDate.split('T')[0];

                    const isDateChanged = existDate !== newDate;
                    const isDemandChanged = Number(existingChange.demand) !== newDemand;
                    const isOnHandChanged = Number(existingChange.onHandInventory) !== newOnHand;
                    const isPoChanged = Number(existingChange.openPoQty) !== newOpenPo;
                    const isFamilyChanged = familyVal !== undefined && existingChange.family !== familyVal;
                    const isSkuChanged = skuVal !== undefined && existingChange.sku !== skuVal;

                    if (isDateChanged || isDemandChanged || isOnHandChanged || isPoChanged || isFamilyChanged || isSkuChanged) {
                        if (isDateChanged && newDate > todayStr) ecn.status = 'Pendiente';
                        existingChange.startDate = newChangeValues.startDate;
                        existingChange.demand = newDemand;
                        existingChange.onHandInventory = newOnHand;
                        existingChange.openPoQty = newOpenPo;
                        if (familyVal !== undefined) existingChange.family = familyVal;
                        if (skuVal !== undefined) existingChange.sku = skuVal;
                        componentChanged = true;
                    }
                } else {
                    const newDate = newChangeValues.startDate.split('T')[0];
                    if (newDate > todayStr) ecn.status = 'Pendiente';
                    ecn.changes.push(newChangeValues);
                    componentChanged = true;
                }

                if (isNewEcn || componentChanged || noteAdded) {
                    ecnsToUpsertMap.set(ecnId, ecn);
                }
            }

            const finalEcnsToUpsert = Array.from(ecnsToUpsertMap.values());

            const transaction = new sql.Transaction(db.pool);
            await transaction.begin();
            let newCount = 0;
            let updatedCount = 0;

            for (const ecn of finalEcnsToUpsert) {
                const initiator = ecn.initiator || 'Sistema';
                const userCheck = await transaction.request().input('uid', sql.NVarChar, initiator).query("SELECT id FROM users WHERE id = @uid");
                if (userCheck.recordset.length === 0) {
                    await transaction.request().input('uid', sql.NVarChar, initiator).input('name', sql.NVarChar, initiator).query("INSERT INTO users (id, name) VALUES (@uid, @name)");
                }

                const request = transaction.request();
                request.input('id', sql.NVarChar, ecn.id);
                const existing = await request.query("SELECT id FROM ecns WHERE id = @id");
                const isUpdate = existing.recordset.length > 0;

                request.input('init', sql.NVarChar, initiator);
                request.input('desc', sql.NVarChar, ecn.description || '');
                request.input('stat', sql.NVarChar, ecn.status);
                request.input('cdat', sql.Date, ecn.creationDate ? new Date(ecn.creationDate) : new Date());
                request.input('idat', sql.Date, ecn.implementationDate ? new Date(ecn.implementationDate) : null);

                if (isUpdate) {
                    await request.query("UPDATE ecns SET initiator=@init, description=@desc, status=@stat, implementation_date=@idat WHERE id=@id");
                    updatedCount++;
                } else {
                    await request.query("INSERT INTO ecns (id, initiator, description, status, creation_date, implementation_date) VALUES (@id, @init, @desc, @stat, @cdat, @idat)");
                    newCount++;
                }

                if (ecn.changes && ecn.changes.length > 0) {
                    for (const change of ecn.changes) {
                        const cReq = transaction.request();
                        cReq.input('ecn_id', sql.NVarChar, ecn.id);
                        cReq.input('assembly', sql.NVarChar, change.assembly || '');
                        cReq.input('assembly_rev', sql.NVarChar, change.assemblyRevision || '');
                        cReq.input('assembly_desc', sql.NVarChar, change.assemblyDescription || '');
                        cReq.input('old_comp', sql.NVarChar, change.oldComponent || '');
                        cReq.input('new_comp', sql.NVarChar, change.newComponent || '');
                        cReq.input('new_comp_rev', sql.NVarChar, change.newComponentRevision || '');
                        cReq.input('new_comp_desc', sql.NVarChar, change.newComponentDescription || '');
                        cReq.input('old_sub', sql.NVarChar, change.oldSubassembly || '');
                        cReq.input('new_sub', sql.NVarChar, change.newSubassembly || '');
                        cReq.input('new_sub_rev', sql.NVarChar, change.newSubassemblyRevision || '');
                        cReq.input('new_sub_desc', sql.NVarChar, change.newSubassemblyDescription || '');
                        cReq.input('sku', sql.NVarChar, change.sku || '');
                        cReq.input('family', sql.NVarChar, change.family || '');
                        cReq.input('demand', sql.Decimal(18, 2), change.demand || 0);
                        cReq.input('on_hand', sql.Decimal(18, 2), change.onHandInventory || 0);
                        cReq.input('open_po', sql.Decimal(18, 2), change.openPoQty || 0);
                        cReq.input('sdate', sql.Date, change.startDate ? new Date(change.startDate) : null);
                        cReq.input('site', sql.NVarChar, change.site || '5205');

                        const existingComp = await cReq.query(`
                            SELECT id FROM component_changes 
                            WHERE ecn_id = @ecn_id AND assembly = @assembly AND old_component = @old_comp AND new_component = @new_comp AND site = @site
                        `);

                        if (existingComp.recordset.length > 0) {
                            const compId = existingComp.recordset[0].id;
                            const uReq = transaction.request();
                            uReq.input('comp_id', sql.UniqueIdentifier, compId);
                            uReq.input('assembly_rev', sql.NVarChar, change.assemblyRevision || '');
                            uReq.input('assembly_desc', sql.NVarChar, change.assemblyDescription || '');
                            uReq.input('new_comp_rev', sql.NVarChar, change.newComponentRevision || '');
                            uReq.input('new_comp_desc', sql.NVarChar, change.newComponentDescription || '');
                            uReq.input('sku', sql.NVarChar, change.sku || '');
                            uReq.input('family', sql.NVarChar, change.family || '');
                            uReq.input('demand', sql.Decimal(18, 2), change.demand || 0);
                            uReq.input('on_hand', sql.Decimal(18, 2), change.onHandInventory || 0);
                            uReq.input('open_po', sql.Decimal(18, 2), change.openPoQty || 0);
                            uReq.input('sdate', sql.Date, change.startDate ? new Date(change.startDate) : null);

                            await uReq.query(`
                                UPDATE component_changes SET
                                    assembly_revision = @assembly_rev,
                                    assembly_description = @assembly_desc,
                                    new_component_revision = @new_comp_rev,
                                    new_component_description = @new_comp_desc,
                                    sku = COALESCE(NULLIF(@sku, ''), sku),
                                    family = COALESCE(NULLIF(@family, ''), family),
                                    demand = @demand,
                                    on_hand_inventory = @on_hand,
                                    open_po_qty = @open_po,
                                    start_date = @sdate
                                WHERE id = @comp_id
                            `);
                        } else {
                            await cReq.query(`
                                INSERT INTO component_changes (
                                    id, ecn_id, assembly, assembly_revision, assembly_description,
                                    old_component, new_component, new_component_revision, new_component_description,
                                    old_subassembly, new_subassembly, new_subassembly_revision, new_subassembly_description,
                                    sku, family, demand, on_hand_inventory, open_po_qty, start_date, site
                                ) VALUES (
                                    NEWID(), @ecn_id, @assembly, @assembly_rev, @assembly_desc,
                                    @old_comp, @new_comp, @new_comp_rev, @new_comp_desc,
                                    @old_sub, @new_sub, @new_sub_rev, @new_sub_desc,
                                    @sku, @family, @demand, @on_hand, @open_po, @sdate, @site
                                )
                            `);
                        }
                    }
                }

                if (ecn.notes && ecn.notes.length > 0) {
                    for (const note of ecn.notes) {
                        if (!note.text || !note.text.trim()) continue;
                        const noteTxt = note.text.trim();
                        const noteCheck = await transaction.request()
                            .input('ecn_id', sql.NVarChar, ecn.id)
                            .input('txt', sql.NVarChar, noteTxt)
                            .query("SELECT id FROM notes WHERE ecn_id = @ecn_id AND text = @txt");

                        if (noteCheck.recordset.length === 0) {
                            const nReq = transaction.request();
                            nReq.input('nid', sql.UniqueIdentifier, uuidv4());
                            nReq.input('ecn_id', sql.NVarChar, ecn.id);
                            nReq.input('author', sql.NVarChar, note.author || initiator);
                            nReq.input('txt', sql.NVarChar, noteTxt);
                            nReq.input('ndate', sql.DateTimeOffset, note.date ? new Date(note.date) : new Date());
                            await nReq.query("INSERT INTO notes (id, ecn_id, author, text, date) VALUES (@nid, @ecn_id, @author, @txt, @ndate)");
                        }
                    }
                }
            }

            const fileName = path.basename(targetFilePath);
            await transaction.request()
                .input('ts', sql.DateTimeOffset, new Date())
                .input('file', sql.NVarChar, fileName)
                .input('total', sql.Int, finalEcnsToUpsert.length)
                .input('new_ecns', sql.NVarChar, `${newCount} nuevos`)
                .input('upd_ecns', sql.NVarChar, `${updatedCount} actualizados`)
                .input('details', sql.NVarChar, `Sincronización automatizada directa SAP desde ${fileName}. Nuevos: ${newCount}, Actualizados: ${updatedCount}. Ignorados 5201: ${skippedPlant5201Count}`)
                .query("INSERT INTO import_logs (timestamp, file_name, total_records, new_ecns, updated_ecns, details) VALUES (@ts, @file, @total, @new_ecns, @upd_ecns, @details)");

            await transaction.request()
                .input('aid', sql.UniqueIdentifier, uuidv4())
                .input('uts', sql.DateTimeOffset, new Date())
                .input('uuser', sql.NVarChar, 'Sistema')
                .input('utype', sql.NVarChar, 'Importación')
                .input('utarget', sql.NVarChar, fileName)
                .input('uact', sql.NVarChar, `Sincronización automatizada SAP directa: ${newCount} nuevos, ${updatedCount} actualizados.`)
                .query("INSERT INTO audit_log (id, timestamp, [user], type, target, action) VALUES (@aid, @uts, @uuser, @utype, @utarget, @uact)");

            await transaction.commit();

            res.json({
                success: true,
                message: `Sincronización automatizada desde ${fileName} completada exitosamente.`,
                newCount,
                updatedCount,
                totalRecords: finalEcnsToUpsert.length,
                skipped5201: skippedPlant5201Count
            });
        } catch (e: any) {
            console.error('VBA Sync Error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/import/users', async (req, res) => {
        const { users, fileName } = req.body;
        const transaction = new sql.Transaction(db.pool);
        try {
            await transaction.begin();
            for (const user of users) {
                await transaction.request()
                    .input('id', sql.NVarChar, user.id)
                    .input('name', sql.NVarChar, user.name)
                    .input('email', sql.NVarChar, user.email)
                    .input('dept', sql.NVarChar, user.department)
                    .input('photo', sql.NVarChar, user.photo || null)
                    .query(`
                        IF EXISTS (SELECT 1 FROM users WHERE id = @id)
                            UPDATE users SET name = @name, email = @email, department = @dept, photo = @photo WHERE id = @id
                        ELSE
                            INSERT INTO users (id, name, email, department, photo) VALUES (@id, @name, @email, @dept, @photo)
                    `);
            }
            await transaction.request()
                .input('aid', sql.UniqueIdentifier, uuidv4())
                .input('uts', sql.DateTimeOffset, new Date())
                .input('uuser', sql.NVarChar, 'Sistema')
                .input('utype', sql.NVarChar, 'Importación')
                .input('utarget', sql.NVarChar, 'Usuarios')
                .input('uact', sql.NVarChar, `Importación de usuarios: ${fileName || 'Manual'}. ${users.length} procesados.`)
                .query("INSERT INTO audit_log (id, timestamp, [user], type, target, action) VALUES (@aid, @uts, @uuser, @utype, @utarget, @uact)");

            await transaction.commit();
            res.json({ success: true });
        } catch (e: any) {
            if (transaction) await transaction.rollback();
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/import/descriptions', async (req, res) => {
        const { data } = req.body;
        const transaction = new sql.Transaction(db.pool);
        try {
            await transaction.begin();
            for (const item of data) {
                await transaction.request()
                    .input('ecn', sql.NVarChar, item.ECN)
                    .input('desc', sql.NVarChar, item.Description)
                    .query("UPDATE ecns SET description = @desc WHERE id = @ecn");
            }
            await transaction.request()
                .input('aid', sql.UniqueIdentifier, uuidv4())
                .input('uts', sql.DateTimeOffset, new Date())
                .input('uuser', sql.NVarChar, 'Sistema')
                .input('utype', sql.NVarChar, 'Importación')
                .input('utarget', sql.NVarChar, 'Descripciones ECN')
                .input('uact', sql.NVarChar, `Importación de descripciones ECN. ${data.length} procesadas.`)
                .query("INSERT INTO audit_log (id, timestamp, [user], type, target, action) VALUES (@aid, @uts, @uuser, @utype, @utarget, @uact)");

            await transaction.commit();
            res.json({ success: true });
        } catch (e: any) {
            if (transaction) await transaction.rollback();
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/import/sku-family', async (req, res) => {
        const { data } = req.body;
        const transaction = new sql.Transaction(db.pool);
        try {
            await transaction.begin();
            for (const item of data) {
                if (!item.Assembly) continue; // Skip rows without an assembly
                await transaction.request()
                    .input('assembly', sql.NVarChar, item.Assembly.trim())
                    .input('sku', sql.NVarChar, (item.SKU || '').trim())
                    .input('family', sql.NVarChar, (item.Family || '').trim())
                    .query("UPDATE component_changes SET sku = @sku, family = @family WHERE assembly = @assembly");
            }
            await transaction.request()
                .input('aid', sql.UniqueIdentifier, uuidv4())
                .input('uts', sql.DateTimeOffset, new Date())
                .input('uuser', sql.NVarChar, 'Sistema')
                .input('utype', sql.NVarChar, 'Importación')
                .input('utarget', sql.NVarChar, 'SKU/Familia')
                .input('uact', sql.NVarChar, `Importación de SKU/Familia por ensamble. ${data.length} procesados.`)
                .query("INSERT INTO audit_log (id, timestamp, [user], type, target, action) VALUES (@aid, @uts, @uuser, @utype, @utarget, @uact)");

            await transaction.commit();
            res.json({ success: true });
        } catch (e: any) {
            if (transaction) await transaction.rollback();
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/import-logs', async (req, res) => {
        try {
            const result = await db.pool.request().query('SELECT * FROM import_logs ORDER BY timestamp DESC');
            res.json(result.recordset);
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/audit-logs', async (req, res) => {
        try {
            const result = await db.pool.request().query('SELECT id, timestamp, [user], action as details, type, target FROM audit_log ORDER BY timestamp DESC');
            res.json(result.recordset);
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/mat-vesda', async (req, res) => {
        try {
            const result = await db.pool.request().query('SELECT * FROM mat_vesda');
            res.json(result.recordset);
        } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/mat-vesda/import', async (req, res) => {
        try {
            const { data } = req.body;
            if (!data || data.length === 0) {
                return res.json({ message: 'No data provided', count: 0 });
            }

            const existingResult = await db.pool.request().query('SELECT material, last_change FROM mat_vesda');
            const existingMap = new Map();
            existingResult.recordset.forEach(m => {
                existingMap.set(m.material, m.last_change);
            });

            let inserted = 0;
            let updated = 0;
            let skipped = 0;

            const transaction = new sql.Transaction(db.pool);
            await transaction.begin();

            try {
                for (const item of data) {
                    const material = String(item.material || '').trim();
                    if (!material) {
                        skipped++;
                        continue;
                    }

                    const newLastChange = item.last_change ? new Date(item.last_change) : null;
                    const hasExisting = existingMap.has(material);
                    const existingLastChangeRaw = existingMap.get(material);
                    const existingLastChange = existingLastChangeRaw ? new Date(existingLastChangeRaw) : null;

                    let shouldUpsert = false;
                    let isUpdate = false;

                    if (hasExisting) {
                        if (newLastChange && (!existingLastChange || newLastChange > existingLastChange)) {
                            shouldUpsert = true;
                            isUpdate = true;
                        } else {
                            skipped++;
                        }
                    } else {
                        shouldUpsert = true;
                        isUpdate = false;
                    }

                    if (shouldUpsert) {
                        const request = transaction.request();
                        request.input('material', sql.NVarChar, material);
                        request.input('price', sql.Decimal(18, 2), item.price || 0);
                        request.input('abc_indicator', sql.NVarChar, item.abc_indicator || '');
                        request.input('material_description', sql.NVarChar, item.material_description || '');
                        request.input('plant', sql.NVarChar, item.plant || '');
                        request.input('last_change', sql.Date, newLastChange);
                        request.input('base_unit_of_measure', sql.NVarChar, item.base_unit_of_measure || '');
                        request.input('purchasing_group', sql.NVarChar, item.purchasing_group || '');
                        request.input('mrp_type', sql.NVarChar, item.mrp_type || '');
                        request.input('valuation_class', sql.NVarChar, item.valuation_class || '');
                        request.input('currency', sql.NVarChar, item.currency || '');
                        request.input('price_unit', sql.Int, item.price_unit || 0);
                        request.input('price_control', sql.NVarChar, item.price_control || '');
                        request.input('material_type', sql.NVarChar, item.material_type || '');
                        request.input('material_group', sql.NVarChar, item.material_group || '');
                        request.input('valuation_type', sql.NVarChar, item.valuation_type || '');
                        request.input('created_by', sql.NVarChar, item.created_by || '');

                        if (isUpdate) {
                            await request.query(`
                                UPDATE mat_vesda SET 
                                    price = @price,
                                    abc_indicator = @abc_indicator,
                                    material_description = @material_description,
                                    plant = @plant,
                                    last_change = @last_change,
                                    base_unit_of_measure = @base_unit_of_measure,
                                    purchasing_group = @purchasing_group,
                                    mrp_type = @mrp_type,
                                    valuation_class = @valuation_class,
                                    currency = @currency,
                                    price_unit = @price_unit,
                                    price_control = @price_control,
                                    material_type = @material_type,
                                    material_group = @material_group,
                                    valuation_type = @valuation_type,
                                    created_by = @created_by
                                WHERE material = @material
                            `);
                            updated++;
                        } else {
                            await request.query(`
                                INSERT INTO mat_vesda (
                                    material, price, abc_indicator, material_description, plant, 
                                    last_change, base_unit_of_measure, purchasing_group, mrp_type, 
                                    valuation_class, currency, price_unit, price_control, 
                                    material_type, material_group, valuation_type, created_by
                                ) VALUES (
                                    @material, @price, @abc_indicator, @material_description, @plant, 
                                    @last_change, @base_unit_of_measure, @purchasing_group, @mrp_type, 
                                    @valuation_class, @currency, @price_unit, @price_control, 
                                    @material_type, @material_group, @valuation_type, @created_by
                                )
                            `);
                            inserted++;
                        }
                    }
                }
                await transaction.commit();
                res.json({ message: 'Imported successfully', inserted, updated, skipped });
            } catch (e: any) {
                if (transaction) await transaction.rollback();
                throw e;
            }
        } catch (e: any) {
            console.error('Import error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/assemblies', async (req, res) => {
        try {
            // Get all unique assemblies and their basic info
            const assembliesResult = await db.pool.request().query(`
                SELECT DISTINCT assembly as id, assembly_description as description 
                FROM component_changes 
                WHERE assembly <> ''
            `);
            const assemblies = assembliesResult.recordset;

            // Get all component changes with ECN info linked to assemblies
            const detailsResult = await db.pool.request().query(`
                SELECT 
                    cc.assembly,
                    cc.new_component as componentId,
                    cc.new_component_description as componentDescription,
                    e.id as ecnId,
                    e.implementation_date as implementationDate,
                    e.status,
                    e.description as ecnDescription
                FROM component_changes cc
                LEFT JOIN ecns e ON cc.ecn_id = e.id
                WHERE cc.assembly <> '' AND cc.new_component <> ''
            `);
            const details = detailsResult.recordset;

            // Grouping logic
            const assemblyMap = new Map();
            assemblies.forEach(a => {
                assemblyMap.set(a.id, { ...a, bom: new Map() });
            });

            details.forEach(d => {
                if (!assemblyMap.has(d.assembly)) return;
                const assembly = assemblyMap.get(d.assembly);

                if (!assembly.bom.has(d.componentId)) {
                    assembly.bom.set(d.componentId, {
                        componentId: d.componentId,
                        description: d.componentDescription || '',
                        ecns: []
                    });
                }

                const component = assembly.bom.get(d.componentId);
                // Avoid duplicate ECNs for the same component in the same assembly
                if (d.ecnId && !component.ecns.some((e: any) => e.id === d.ecnId)) {
                    component.ecns.push({
                        id: d.ecnId,
                        implementationDate: d.implementationDate,
                        status: d.status,
                        description: d.ecnDescription
                    });
                }
            });

            // Convert Maps back to Arrays
            const finalResult = Array.from(assemblyMap.values()).map(a => ({
                ...a,
                bom: Array.from(a.bom.values())
            }));

            res.json(finalResult);
        } catch (e: any) {
            console.error('[Assemblies API Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.put('/api/components/description', async (req, res) => {
        try {
            const { componentId, description } = req.body;
            await db.pool.request()
                .input('cid', sql.NVarChar, componentId)
                .input('desc', sql.NVarChar, description)
                .query(`
                    UPDATE component_changes 
                    SET new_component_description = @desc 
                    WHERE new_component = @cid;
                    
                    UPDATE component_changes 
                    SET assembly_description = @desc 
                    WHERE assembly = @cid;
                `);
            res.json({ success: true });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/settings/email', async (req, res) => {
        try {
            const result = await db.pool.request().query("SELECT [key], value FROM settings WHERE [key] LIKE 'email_%'");
            const settings: any = {};
            result.recordset.forEach(r => {
                const key = r.key.replace('email_', '');
                settings[key] = r.value;
            });
            res.json(settings);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/settings/email', async (req, res) => {
        try {
            const settings = req.body;
            const transaction = new sql.Transaction(db.pool);
            await transaction.begin();
            try {
                for (const key of Object.keys(settings)) {
                    await transaction.request()
                        .input('k', sql.NVarChar, `email_${key}`)
                        .input('v', sql.NVarChar, String(settings[key]))
                        .query(`
                            IF EXISTS (SELECT 1 FROM settings WHERE [key] = @k)
                                UPDATE settings SET value = @v WHERE [key] = @k
                            ELSE
                                INSERT INTO settings ([key], value) VALUES (@k, @v)
                        `);
                }
                await transaction.commit();
                res.json({ success: true });
            } catch (err) {
                await transaction.rollback();
                throw err;
            }
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/database', async (req, res) => {
        try {
            // Dangerous operation: wipe tables in order
            await db.pool.request().query(`
                DELETE FROM audit_log;
                DELETE FROM checklist_items;
                DELETE FROM notes;
                DELETE FROM component_changes;
                DELETE FROM ecns;
                DELETE FROM import_logs;
                DELETE FROM mat_vesda;
            `);
            res.json({ message: 'Database cleared' });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    const getEmailTransporter = async () => {
        const result = await db.pool.request().query("SELECT [key], value FROM settings WHERE [key] LIKE 'email_%'");
        const settings: any = {};
        result.recordset.forEach(r => {
            const key = r.key.replace('email_', '');
            settings[key] = r.value;
        });

        const host = settings.host || 'smtp.honeywell.com';
        const port = parseInt(settings.port || '25');
        const from = settings.from || 'ecn-manager@honeywell.com';
        const fromName = settings.fromName || 'ECN Manager';

        const transportOptions: any = {
            host: host,
            port: port,
            secure: settings.secure === 'true',
            tls: {
                rejectUnauthorized: false
            },
            lookup: (hostname: string, options: any, callback: any) => {
                dns.lookup(hostname, { family: 4 }, callback);
            }
        };

        if (settings.user && settings.pass) {
            transportOptions.auth = {
                user: settings.user,
                pass: settings.pass
            };
        }

        return {
            transporter: nodemailer.createTransport(transportOptions),
            from,
            fromName
        };
    };

    app.post('/api/settings/email/test', async (req, res) => {
        try {
            const host = req.body.host || "smtp.honeywell.com";
            const port = parseInt(req.body.port || '25');
            const from = req.body.from || "ecn-manager@honeywell.com";
            const to = req.body.to || "albertoisaac.aguilera@honeywell.com";
            const user = req.body.user;
            const pass = req.body.pass;

            console.log(`[Honeywell Relay Test] Enviando vía ${host}:${port} hacia: ${to} desde: ${from}`);

            const transportOptions: any = {
                host: host,
                port: port,
                secure: false,
                tls: {
                    rejectUnauthorized: false
                },
                lookup: (hostname: string, options: any, callback: any) => {
                    dns.lookup(hostname, { family: 4 }, callback);
                }
            };

            if (user && pass) {
                transportOptions.auth = { user, pass };
            }

            const transporter = nodemailer.createTransport(transportOptions);

            const info = await transporter.sendMail({
                from: from.includes('<') ? from : `"ECN Manager" <${from}>`,
                to: to,
                subject: 'Prueba ECN Manager - Honeywell Relay SMTP',
                html: '<h3>Prueba de correo exitosa</h3><p>Este mensaje fue enviado a través del relay corporativo SMTP de Honeywell (smtp.honeywell.com).</p>'
            });

            console.log('[Honeywell Relay Success]', info);
            res.json({
                success: true,
                message: 'Correo enviado exitosamente vía smtp.honeywell.com',
                info
            });

        } catch (e: any) {
            console.error('[Honeywell Relay Error]', e);
            res.status(500).json({
                error: e.message
            });
        }
    });

    app.post('/api/notify/ecn-implemented', async (req, res) => {
        try {
            const ecn = req.body;
            const { transporter, from, fromName } = await getEmailTransporter();

            const result = await db.pool.request().query("SELECT value FROM settings WHERE [key] = 'email_to'");
            const toEmail = result.recordset[0]?.value;

            if (!toEmail) throw new Error('No se ha configurado un destinatario global (email_to).');

            const html = `
                <h2>ECN Implementado: ${ecn.id}</h2>
                <p><strong>Descripción:</strong> ${ecn.description}</p>
                <p><strong>Iniciador:</strong> ${ecn.initiator}</p>
                <p><strong>Fecha de Implementación:</strong> ${ecn.implementationDate}</p>
                <hr/>
                <p>Este es un mensaje automático del Sistema de Gestión de ECN.</p>
            `;

            await transporter.sendMail({
                from: `"${fromName}" <${from}>`,
                to: toEmail,
                subject: `[IMP] ECN Implementado: ${ecn.id}`,
                html
            });

            res.json({ message: 'Notificación enviada' });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/email/weekly-summary', async (req, res) => {
        try {
            const { transporter, from, fromName } = await getEmailTransporter();

            const result = await db.pool.request().query("SELECT value FROM settings WHERE [key] = 'email_to'");
            const toEmail = result.recordset[0]?.value;

            if (!toEmail) throw new Error('No se ha configurado un destinatario global (email_to).');

            // Obtener ECNs de la última semana
            const ecnsResult = await db.pool.request().query(`
                SELECT TOP 50 id, description, initiator, status, implementation_date, creation_date
                FROM ecns
                WHERE creation_date >= DATEADD(day, -7, GETDATE())
                   OR implementation_date >= DATEADD(day, -7, GETDATE())
                ORDER BY creation_date DESC
            `);

            const ecns = ecnsResult.recordset;

            const rows = ecns.map(e => `
                <tr>
                    <td style="padding:6px;border:1px solid #ddd;">${e.id}</td>
                    <td style="padding:6px;border:1px solid #ddd;">${e.description || '-'}</td>
                    <td style="padding:6px;border:1px solid #ddd;">${e.initiator || '-'}</td>
                    <td style="padding:6px;border:1px solid #ddd;">${e.status || '-'}</td>
                    <td style="padding:6px;border:1px solid #ddd;">${e.implementation_date ? new Date(e.implementation_date).toLocaleDateString() : '-'}</td>
                </tr>
            `).join('');

            const html = `
                <h2>Resumen Semanal de ECNs</h2>
                <p>A continuación se muestran los ECNs de los últimos 7 días:</p>
                <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;">
                    <thead>
                        <tr style="background:#004080;color:#fff;">
                            <th style="padding:8px;border:1px solid #ddd;">ID</th>
                            <th style="padding:8px;border:1px solid #ddd;">Descripción</th>
                            <th style="padding:8px;border:1px solid #ddd;">Iniciador</th>
                            <th style="padding:8px;border:1px solid #ddd;">Estado</th>
                            <th style="padding:8px;border:1px solid #ddd;">Fecha Impl.</th>
                        </tr>
                    </thead>
                    <tbody>${rows || '<tr><td colspan="5" style="text-align:center;padding:10px;">Sin ECNs en los últimos 7 días</td></tr>'}</tbody>
                </table>
                <hr/>
                <p style="color:#888;font-size:12px;">Este es un mensaje automático del Sistema de Gestión de ECN.</p>
            `;

            await transporter.sendMail({
                from: `"${fromName}" <${from}>`,
                to: toEmail,
                subject: `[ECN Manager] Resumen Semanal - ${new Date().toLocaleDateString()}`,
                html
            });

            res.json({ message: 'Resumen semanal enviado exitosamente', total: ecns.length });
        } catch (e: any) {
            console.error('[Weekly Summary Error]', e);
            res.status(500).json({ error: e.message });
        }
    });

    // --- Settings Routes ---
    app.get('/api/settings/:key', async (req, res) => {
        try {
            const { key } = req.params;
            const result = await db.pool.request()
                .input('key', sql.NVarChar, key)
                .query('SELECT value FROM settings WHERE [key] = @key');
            if (result.recordset.length === 0) {
                return res.json({ key, value: null });
            }
            res.json({ key, value: result.recordset[0].value });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/settings', async (req, res) => {
        try {
            const { key, value } = req.body;
            if (!key) return res.status(400).json({ error: 'key is required' });
            await db.pool.request()
                .input('key', sql.NVarChar, key)
                .input('value', sql.NVarChar, String(value ?? ''))
                .query(`
                    IF EXISTS (SELECT 1 FROM settings WHERE [key] = @key)
                        UPDATE settings SET value = @value WHERE [key] = @key
                    ELSE
                        INSERT INTO settings ([key], value) VALUES (@key, @value)
                `);
            res.json({ success: true, key, value });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // Final API 404 handler - prevents /api requests from falling back to SPA HTML

    app.all(/^\/api(\/.*)?$/, (req, res) => {
        res.status(404).json({
            error: 'API Endpoint not found',
            path: req.path,
            method: req.method
        });
    });

    // Vite middleware for development
    if (!isProduction) {
        try {
            const { createServer: createViteServer } = await import('vite');
            const vite = await createViteServer({
                server: { middlewareMode: true },
                appType: 'spa',
            });
            app.use(vite.middlewares);
        } catch (e) {
            console.error('[Server] Failed to load Vite middleware:', e);
            // Fallback to static if Vite fails even in dev
            app.use(express.static(distPath));
            app.get(/^(?!\/api).*/, (req, res, next) => {
                if (req.path.startsWith('/api')) {
                    return res.status(404).json({ error: 'API route not found (vite-fallback)' });
                }
                if (req.path.includes('.')) return next();
                res.sendFile(path.join(distPath, 'index.html'));
            });
        }
    } else {
        app.use(express.static(distPath));
        // Catch-all route for SPA
        // Matches everything EXCEPT strings starting with /api
        app.get(/^(?!\/api).*/, (req, res, next) => {
            // Extra safety: if it somehow starts with /api here, it's definitely a 404
            if (req.path.startsWith('/api')) {
                return res.status(404).json({ error: 'API route not found (SPA-leak)' });
            }
            if (req.path.includes('.')) {
                return next();
            }
            res.sendFile(path.join(distPath, 'index.html'));
        });
    }

    // Start listening AFTER all routes are registered
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[Server] Listening on port ${PORT} (isProduction: ${isProduction})`);
    });
}

startServer().catch((err: any) => {
    console.error('[Server] Critical startup error:', err);
    process.exit(1);
});
