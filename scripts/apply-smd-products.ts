import 'dotenv/config';
import * as db from '../db.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { matchSmdProducts } from '../services/smdProducts';

async function main() {
    await db.init();
    if (!db.isLiveMssqlConnected()) throw new Error('No hay conexión SQL real; no se han aplicado las relaciones SMD.');
    const links = (await db.pool.request().query(`
        SELECT l.*, e.description AS ecnDescription FROM dbo.component_change_smd_products l
        INNER JOIN dbo.ecns e ON e.id=l.ecnId
        ORDER BY l.ecnId, l.smdBase, l.sku, l.sourceField
    `)).recordset;
    const changes = (await db.pool.request().query('SELECT id, ecn_id, assembly, old_subassembly, new_subassembly, old_component, new_component FROM dbo.component_changes')).recordset;
    const key = (link: any) => [link.changeId, link.sku, link.family, link.smdBase, link.matchedPart, link.sourceField].map(value => String(value).trim().toUpperCase()).join('|');
    const actual = new Set(links.map(key));
    let expected = 0;
    for (const change of changes) for (const link of matchSmdProducts(change)) {
        expected++;
        if (!actual.has(key(link))) throw new Error(`Falta la asociación SMD ${link.matchedPart} / ${link.sku} del ECN ${link.ecnId}.`);
    }
    const summary = {
        affectedEcns: new Set(links.map(link => link.ecnId)).size,
        affectedChanges: new Set(links.map(link => link.changeId)).size,
        ecnSkuFamilyAssociations: new Set(links.map(link => [link.ecnId, link.sku, link.family].join('|'))).size,
        relatedSkus: new Set(links.map(link => link.sku)).size,
        relatedFamilies: [...new Set(links.map(link => link.family))].sort(),
        verifiedMatches: expected
    };
    const headers = ['ecnId', 'ecnDescription', 'changeId', 'sourceField', 'matchedPart', 'smdBase', 'sku', 'family'];
    const csv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const report = [headers.map(csv).join(','), ...links.map(link => headers.map(header => csv(link[header])).join(','))].join('\r\n');
    await fs.mkdir(path.resolve('reports'), { recursive: true });
    await fs.writeFile(path.resolve('reports/smd-ecn-matches.csv'), '\uFEFF' + report, 'utf8');
    const ecnRows = [...new Set(links.map(link => link.ecnId))].sort().map(ecnId => {
        const matches = links.filter(link => link.ecnId === ecnId);
        return [ecnId, matches[0].ecnDescription, [...new Set(matches.map(link => link.sku))].sort().join(', '),
            [...new Set(matches.map(link => link.family))].sort().join(', '), [...new Set(matches.map(link => link.smdBase))].sort().join(', ')];
    });
    await fs.writeFile(path.resolve('reports/smd-ecn-summary.csv'), '\uFEFF' + [
        ['ECN', 'Descripción', 'SKUs asociados', 'Familias', 'Referencias SMD'].map(csv).join(','),
        ...ecnRows.map(row => row.map(csv).join(','))
    ].join('\r\n'), 'utf8');
    await fs.writeFile(path.resolve('reports/smd-ecn-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify(summary));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await db.pool.close(); });
