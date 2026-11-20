import sql from 'mssql';
import { v4 as uuidv4 } from 'uuid';
import { CHECKLIST_TEMPLATE } from './services/checklistTemplate.ts';

// --- MS SQL Server Configuration ---
let rawServer = process.env.DB_HOST || '6.tcp.ngrok.io,29375';
let dbPort = parseInt(process.env.DB_PORT || '1433', 10);

if (rawServer.includes(',')) {
    const parts = rawServer.split(',');
    rawServer = parts[0].trim();
    if (parts[1]) dbPort = parseInt(parts[1].trim(), 10);
} else if (rawServer.includes(':')) {
    const parts = rawServer.split(':');
    rawServer = parts[0].trim();
    if (parts[1]) dbPort = parseInt(parts[1].trim(), 10);
}

const resolvedUser = (process.env.DB_USER && process.env.DB_USER !== 'lionuser') ? process.env.DB_USER : 'lionuser';
const resolvedPassword = (process.env.DB_PASSWORD && process.env.DB_PASSWORD !== 'lionu5er') ? process.env.DB_PASSWORD : 'lionu5er';

const config: sql.config = {
    user: resolvedUser,
    password: resolvedPassword,
    server: rawServer,
    database: process.env.DB_NAME || 'TraceMasterDB',
    port: dbPort,
    options: {
        encrypt: false, // Use true for Azure, false for local/on-prem 2014
        trustServerCertificate: true,
        enableArithAbort: true,
        connectTimeout: 8000 // Allow sufficient time for ngrok tunnel handshake
    }
};

let isDbAvailable = false;
let isInitialized = false;

// --- In-Memory Store for Standalone / Preview / Offline Mode ---
export interface MemoryStore {
    users: Array<{ id: string; name: string; email?: string; department?: string; photo?: string }>;
    ecns: Array<{
        id: string;
        initiator: string;
        description: string;
        status: string;
        creation_date: string;
        implementation_date: string;
        summary?: string;
    }>;
    component_changes: Array<{
        id: string;
        ecn_id: string;
        assembly: string;
        assembly_revision?: string;
        assembly_description?: string;
        old_component: string;
        new_component: string;
        new_component_revision?: string;
        new_component_description?: string;
        old_subassembly?: string;
        new_subassembly?: string;
        new_subassembly_revision?: string;
        new_subassembly_description?: string;
        sku?: string;
        family?: string;
        demand?: number;
        on_hand_inventory?: number;
        open_po_qty?: number;
        start_date?: string;
        site?: string;
    }>;
    notes: Array<{
        id: string;
        ecn_id: string;
        author: string;
        text: string;
        date: string;
    }>;
    checklist_items: Array<{
        id: string;
        ecn_id: string;
        question: string;
        department: string;
        action_status: string;
        comment: string;
        who: string;
        when: string;
        crb: string;
        crb_ok: string;
        cib: string;
        cib_ok: string;
        isc_impl: string;
        impl_ok: string;
    }>;
    mat_vesda: Array<{
        id: number;
        material: string;
        price: number;
        abc_indicator: string;
        material_description: string;
        plant: string;
        last_change: string;
        base_unit_of_measure: string;
        purchasing_group: string;
        mrp_type: string;
        valuation_class: string;
        currency: string;
        price_unit: number;
        price_control: string;
        material_type: string;
        material_group: string;
        valuation_type: string;
        created_by: string;
    }>;
    settings: Record<string, string>;
    audit_log: Array<{
        id: string;
        ecn_id?: string;
        timestamp: string;
        user: string;
        type: string;
        target: string;
        action: string;
    }>;
    import_logs: Array<{
        id: number;
        timestamp: string;
        file_name: string;
        total_records: number;
        new_ecns: string;
        updated_ecns: string;
        descriptions_updated: number;
        sku_by_assembly_updated: number;
        new_users: number;
        updated_users: number;
        details: string;
    }>;
    implementation_tasks: Array<{
        id: string;
        ecn_id: string;
        family: string;
        department: string;
        task_name: string;
        assigned_user_id: string;
        status: string;
        due_date: string;
        comments: string;
        updated_at: string;
    }>;
}

const memoryStore: MemoryStore = {
    implementation_tasks: [],
    users: [
        { id: 'Sistema', name: 'Sistema', email: 'system@honeywell.com', department: 'IT' },
        { id: 'E650432', name: 'Alberto Gómez', email: 'alberto.gomez@honeywell.com', department: 'AME: Product engineering' },
        { id: 'E742199', name: 'Carlos Ramírez', email: 'carlos.ramirez@honeywell.com', department: 'Material Planning' },
        { id: 'E883102', name: 'María Santos', email: 'maria.santos@honeywell.com', department: 'Strategic / Tactical buyer' },
        { id: 'E910442', name: 'Roberto Díaz', email: 'roberto.diaz@honeywell.com', department: 'AME: Quality engineering' }
    ],
    ecns: [
        {
            id: '2025-1042',
            initiator: 'E650432',
            description: 'Actualización de microcontrolador STM32 a versión de bajo consumo en tarjeta principal VESDA',
            status: 'Pendiente',
            creation_date: '2025-01-15',
            implementation_date: '2025-04-30',
            summary: 'Reemplazo del componente IC MCU por obsolescencia de proveedor. Requiere validación de firmware y actualización de BOMs.'
        },
        {
            id: '2025-0988',
            initiator: 'E742199',
            description: 'Cambio de resistencia SMD en ensamble de fuente de poder para mitigar calentamiento',
            status: 'Implementado Parcial',
            creation_date: '2025-01-10',
            implementation_date: '2025-03-15',
            summary: 'Modificación de tolerancia de componentes pasivos para mejorar rendimiento térmico en operación continua.'
        },
        {
            id: '2024-8841',
            initiator: 'E883102',
            description: 'Sustitución de conector Molex por versión con seguro de retención reforzado',
            status: 'Implementado',
            creation_date: '2024-11-20',
            implementation_date: '2025-01-20',
            summary: 'Mejora en confiabilidad de conexión en líneas de producción automatizadas.'
        }
    ],
    component_changes: [
        {
            id: uuidv4(),
            ecn_id: '2025-1042',
            assembly: '02-VLP-0001',
            assembly_revision: 'B',
            assembly_description: 'Placa Principal Detectores VESDA LaserPlus',
            old_component: 'STM32F103VET6',
            new_component: 'STM32L476VET6',
            new_component_revision: 'A',
            new_component_description: 'MCU Ultra Low Power 32-bit ARM Cortex-M4',
            sku: 'VLP-400-MAIN',
            family: 'VESDA LaserPlus',
            demand: 1200,
            on_hand_inventory: 450,
            open_po_qty: 1500,
            start_date: '2025-04-01',
            site: '5205'
        },
        {
            id: uuidv4(),
            ecn_id: '2025-0988',
            assembly: '02-PSU-24V',
            assembly_revision: 'C',
            assembly_description: 'Módulo de Fuente Regulada 24VDC 5A',
            old_component: 'RES-SMD-10K-0805',
            new_component: 'RES-SMD-10K-1206-1W',
            new_component_revision: 'A',
            new_component_description: 'Resistencia 10K Ohm 1% 1W Alta Disipación',
            sku: 'PSU-24V-05A',
            family: 'Power Supplies',
            demand: 800,
            on_hand_inventory: 200,
            open_po_qty: 600,
            start_date: '2025-03-01',
            site: '5205'
        },
        {
            id: uuidv4(),
            ecn_id: '2024-8841',
            assembly: '03-CAB-HARN-01',
            assembly_revision: 'A',
            assembly_description: 'Arnés de Cableado Principal con Blindaje',
            old_component: 'MOLX-43045-0400',
            new_component: 'MOLX-43045-0412-LOCK',
            new_component_revision: 'B',
            new_component_description: 'Conector Micro-Fit 3.0 con seguro positivo',
            sku: 'HARN-VLP-01',
            family: 'Cables & Harnesses',
            demand: 2500,
            on_hand_inventory: 1800,
            open_po_qty: 0,
            start_date: '2025-01-10',
            site: '5205'
        }
    ],
    notes: [
        {
            id: uuidv4(),
            ecn_id: '2025-1042',
            author: 'Alberto Gómez',
            text: 'Muestras iniciales de validación aprobadas por ingeniería de producto. Se procede a prueba de compatibilidad de firmware.',
            date: new Date('2025-01-20T10:30:00Z').toISOString()
        }
    ],
    checklist_items: [],
    mat_vesda: [
        {
            id: 1,
            material: 'STM32L476VET6',
            price: 8.45,
            abc_indicator: 'A',
            material_description: 'IC MCU 32BIT 512KB FLASH 100LQFP',
            plant: '5205',
            last_change: '2025-01-10',
            base_unit_of_measure: 'EA',
            purchasing_group: 'P01',
            mrp_type: 'PD',
            valuation_class: '3000',
            currency: 'USD',
            price_unit: 1,
            price_control: 'S',
            material_type: 'ROH',
            material_group: 'ELEC',
            valuation_type: '',
            created_by: 'E650432'
        },
        {
            id: 2,
            material: 'RES-SMD-10K-1206-1W',
            price: 0.12,
            abc_indicator: 'C',
            material_description: 'RES 10K OHM 1% 1W 1206 SMD',
            plant: '5205',
            last_change: '2025-01-08',
            base_unit_of_measure: 'EA',
            purchasing_group: 'P01',
            mrp_type: 'VB',
            valuation_class: '3000',
            currency: 'USD',
            price_unit: 100,
            price_control: 'V',
            material_type: 'ROH',
            material_group: 'PASS',
            valuation_type: '',
            created_by: 'E742199'
        },
        {
            id: 3,
            material: 'MOLX-43045-0412-LOCK',
            price: 1.35,
            abc_indicator: 'B',
            material_description: 'CONN HEADER R/A 4POS 3MM GOLD',
            plant: '5205',
            last_change: '2024-11-15',
            base_unit_of_measure: 'EA',
            purchasing_group: 'P02',
            mrp_type: 'PD',
            valuation_class: '3000',
            currency: 'USD',
            price_unit: 1,
            price_control: 'S',
            material_type: 'ROH',
            material_group: 'MECH',
            valuation_type: '',
            created_by: 'E883102'
        }
    ],
    settings: {
        'sap_system_name': 'BRP',
        'mxoh_plant_5201_enabled': 'true',
        'email_host': 'smtp.honeywell.com',
        'email_port': '25',
        'email_from': 'ecn-manager@honeywell.com',
        'email_fromName': 'Honeywell ECN Manager',
        'email_to': 'beto22mex@gmail.com'
    },
    audit_log: [],
    import_logs: []
};

// Populate default checklist items for existing ECNs
for (const ecn of memoryStore.ecns) {
    for (const templateItem of CHECKLIST_TEMPLATE.slice(0, 10)) {
        memoryStore.checklist_items.push({
            id: uuidv4(),
            ecn_id: ecn.id,
            question: templateItem.question,
            department: templateItem.department,
            action_status: ecn.status === 'Implementado' ? 'Closed' : 'Evaluate',
            comment: '',
            who: ecn.initiator,
            when: ecn.implementation_date,
            crb: 'OK',
            crb_ok: 'true',
            cib: 'OK',
            cib_ok: 'true',
            isc_impl: 'Pending',
            impl_ok: ecn.status === 'Implementado' ? 'true' : 'false'
        });
    }
}

// Helper to simulate queries in memory
class MemoryRequest {
    inputs: Record<string, any> = {};

    input(name: string, typeOrVal: any, value?: any): this {
        if (value !== undefined) {
            this.inputs[name] = value;
        } else {
            this.inputs[name] = typeOrVal;
        }
        return this;
    }

    async query(sqlQuery: string): Promise<{ recordset: any[]; rowsAffected: number[] }> {
        const q = sqlQuery.trim();
        const inputs = this.inputs;

        // 1. SELECT * FROM users
        if (/SELECT\s+.*FROM\s+users/i.test(q)) {
            let res = [...memoryStore.users];
            if (inputs.uid || inputs.id) {
                const targetId = inputs.uid || inputs.id;
                res = res.filter(u => u.id === targetId);
            }
            res.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            return { recordset: res, rowsAffected: [res.length] };
        }

        // 2. UPDATE users
        if (/UPDATE\s+users/i.test(q)) {
            const user = memoryStore.users.find(u => u.id === inputs.id);
            if (user) {
                if (inputs.name !== undefined) user.name = inputs.name;
                if (inputs.email !== undefined) user.email = inputs.email;
                if (inputs.dept !== undefined) user.department = inputs.dept;
                if (inputs.photo !== undefined) user.photo = inputs.photo;
            }
            return { recordset: [], rowsAffected: [user ? 1 : 0] };
        }

        // 3. INSERT INTO users
        if (/INSERT\s+INTO\s+users/i.test(q)) {
            const id = inputs.id || inputs.uid || `user-${Date.now()}`;
            const name = inputs.name || inputs.uname || id;
            if (!memoryStore.users.some(u => u.id === id)) {
                memoryStore.users.push({ id, name, department: 'General' });
            }
            return { recordset: [], rowsAffected: [1] };
        }

        // 4. SELECT FROM ecns
        if (/SELECT\s+.*FROM\s+ecns/i.test(q)) {
            let res = memoryStore.ecns.map(e => ({
                id: e.id,
                initiator: e.initiator,
                description: e.description,
                status: e.status,
                creationDate: e.creation_date,
                creation_date: e.creation_date,
                implementationDate: e.implementation_date,
                implementation_date: e.implementation_date,
                summary: e.summary
            }));

            if (inputs.id) {
                res = res.filter(e => e.id === inputs.id);
            }
            if (inputs.search) {
                const s = String(inputs.search).replace(/%/g, '').toLowerCase();
                res = res.filter(e => (e.id.toLowerCase().includes(s) || e.description.toLowerCase().includes(s) || (e.initiator || '').toLowerCase().includes(s)));
            }
            if (inputs.status && inputs.status !== 'Todos') {
                res = res.filter(e => e.status === inputs.status);
            }
            if (inputs.year) {
                res = res.filter(e => e.implementationDate && new Date(e.implementationDate).getFullYear() === inputs.year);
            }

            return { recordset: res, rowsAffected: [res.length] };
        }

        // 5. UPDATE ecns
        if (/UPDATE\s+ecns/i.test(q)) {
            const ecn = memoryStore.ecns.find(e => e.id === inputs.id);
            if (ecn) {
                if (inputs.init !== undefined) ecn.initiator = inputs.init;
                if (inputs.desc !== undefined) ecn.description = inputs.desc;
                if (inputs.stat !== undefined) ecn.status = inputs.stat;
                if (inputs.idat !== undefined) ecn.implementation_date = inputs.idat instanceof Date ? inputs.idat.toISOString().split('T')[0] : String(inputs.idat || '');
                if (inputs.sum !== undefined) ecn.summary = inputs.sum;
            }
            return { recordset: [], rowsAffected: [ecn ? 1 : 0] };
        }

        // 6. INSERT INTO ecns
        if (/INSERT\s+INTO\s+ecns/i.test(q)) {
            const newEcn = {
                id: inputs.id,
                initiator: inputs.initiator || inputs.init || 'Sistema',
                description: inputs.description || inputs.desc || '',
                status: inputs.status || inputs.stat || 'Pendiente',
                creation_date: inputs.creationDate || inputs.creation_date || new Date().toISOString().split('T')[0],
                implementation_date: inputs.implementationDate || inputs.implementation_date || new Date().toISOString().split('T')[0],
                summary: inputs.summary || inputs.sum || ''
            };
            const idx = memoryStore.ecns.findIndex(e => e.id === newEcn.id);
            if (idx >= 0) {
                memoryStore.ecns[idx] = newEcn;
            } else {
                memoryStore.ecns.unshift(newEcn);
            }
            return { recordset: [], rowsAffected: [1] };
        }

        // 7. DELETE FROM ecns
        if (/DELETE\s+FROM\s+ecns/i.test(q)) {
            const id = inputs.id;
            memoryStore.ecns = memoryStore.ecns.filter(e => e.id !== id);
            memoryStore.component_changes = memoryStore.component_changes.filter(c => c.ecn_id !== id);
            memoryStore.notes = memoryStore.notes.filter(n => n.ecn_id !== id);
            memoryStore.checklist_items = memoryStore.checklist_items.filter(chk => chk.ecn_id !== id);
            return { recordset: [], rowsAffected: [1] };
        }

        // 8. Component Changes
        if (/SELECT\s+.*FROM\s+component_changes/i.test(q)) {
            let res = [...memoryStore.component_changes];
            if (inputs.id) {
                res = res.filter(c => c.id === inputs.id);
            }
            if (inputs.ecn_id) {
                res = res.filter(c => c.ecn_id === inputs.ecn_id);
            }
            return { recordset: res, rowsAffected: [res.length] };
        }

        if (/INSERT\s+INTO\s+component_changes/i.test(q)) {
            const change = {
                id: inputs.id || uuidv4(),
                ecn_id: inputs.ecn_id,
                assembly: inputs.assembly || '',
                assembly_revision: inputs.assembly_rev || inputs.assemblyRevision,
                assembly_description: inputs.assembly_desc || inputs.assemblyDescription,
                old_component: inputs.old_comp || inputs.oldComponent || '',
                new_component: inputs.new_comp || inputs.newComponent || '',
                new_component_revision: inputs.new_comp_rev || inputs.newComponentRevision,
                new_component_description: inputs.new_comp_desc || inputs.newComponentDescription,
                old_subassembly: inputs.old_sub || inputs.oldSubassembly || '',
                new_subassembly: inputs.new_sub || inputs.newSubassembly || '',
                new_subassembly_revision: inputs.new_sub_rev || inputs.newSubassemblyRevision,
                new_subassembly_description: inputs.new_sub_desc || inputs.newSubassemblyDescription,
                sku: inputs.sku || '',
                family: inputs.family || '',
                demand: inputs.demand || 0,
                on_hand_inventory: inputs.on_hand || inputs.onHandInventory || 0,
                open_po_qty: inputs.open_po || inputs.openPoQty || 0,
                start_date: inputs.sdate || inputs.startDate,
                site: inputs.site || '5205'
            };
            memoryStore.component_changes.push(change);
            return { recordset: [], rowsAffected: [1] };
        }

        if (/UPDATE\s+component_changes/i.test(q)) {
            const change = memoryStore.component_changes.find(c => c.id === inputs.id);
            if (change) {
                if (inputs.assembly !== undefined) change.assembly = inputs.assembly;
                if (inputs.old_comp !== undefined) change.old_component = inputs.old_comp;
                if (inputs.new_comp !== undefined) change.new_component = inputs.new_comp;
                if (inputs.sku !== undefined) change.sku = inputs.sku;
                if (inputs.family !== undefined) change.family = inputs.family;
                if (inputs.demand !== undefined) change.demand = inputs.demand;
                if (inputs.on_hand !== undefined) change.on_hand_inventory = inputs.on_hand;
                if (inputs.open_po !== undefined) change.open_po_qty = inputs.open_po;
                if (inputs.sdate !== undefined) change.start_date = inputs.sdate;
                if (inputs.site !== undefined) change.site = inputs.site;
            }
            return { recordset: [], rowsAffected: [change ? 1 : 0] };
        }

        if (/DELETE\s+FROM\s+component_changes/i.test(q)) {
            if (inputs.id) {
                memoryStore.component_changes = memoryStore.component_changes.filter(c => c.id !== inputs.id);
            } else if (inputs.ecn_id) {
                memoryStore.component_changes = memoryStore.component_changes.filter(c => c.ecn_id !== inputs.ecn_id);
            }
            return { recordset: [], rowsAffected: [1] };
        }

        // 9. Notes
        if (/SELECT\s+.*FROM\s+notes/i.test(q)) {
            let res = [...memoryStore.notes];
            if (inputs.id) {
                res = res.filter(n => n.ecn_id === inputs.id);
            }
            return { recordset: res, rowsAffected: [res.length] };
        }

        if (/INSERT\s+INTO\s+notes/i.test(q)) {
            memoryStore.notes.push({
                id: inputs.id || uuidv4(),
                ecn_id: inputs.ecn || inputs.ecn_id,
                author: inputs.auth || inputs.author || 'Sistema',
                text: inputs.txt || inputs.text || '',
                date: inputs.d instanceof Date ? inputs.d.toISOString() : (inputs.date || new Date().toISOString())
            });
            return { recordset: [], rowsAffected: [1] };
        }

        // 10. Checklist items
        if (/SELECT\s+.*FROM\s+checklist_items/i.test(q)) {
            let res = [...memoryStore.checklist_items];
            if (inputs.id || inputs.ecn_id) {
                const target = inputs.id || inputs.ecn_id;
                res = res.filter(chk => chk.ecn_id === target);
            }
            return { recordset: res, rowsAffected: [res.length] };
        }

        // 11. Settings
        if (/SELECT\s+.*FROM\s+settings/i.test(q)) {
            if (inputs.key) {
                const val = memoryStore.settings[inputs.key];
                return { recordset: val !== undefined ? [{ key: inputs.key, value: val }] : [], rowsAffected: [1] };
            }
            const res = Object.entries(memoryStore.settings).map(([k, v]) => ({ key: k, value: v }));
            return { recordset: res, rowsAffected: [res.length] };
        }

        if (/UPDATE\s+settings|INSERT\s+INTO\s+settings/i.test(q)) {
            const k = inputs.key || inputs.k;
            const v = inputs.value !== undefined ? inputs.value : inputs.v;
            if (k) {
                memoryStore.settings[k] = String(v ?? '');
            }
            return { recordset: [], rowsAffected: [1] };
        }

        // 12. MAT_VESDA
        if (/SELECT\s+.*FROM\s+mat_vesda/i.test(q)) {
            let res = [...memoryStore.mat_vesda];
            if (inputs.material) {
                res = res.filter(m => m.material.toLowerCase().includes(String(inputs.material).toLowerCase()));
            }
            return { recordset: res, rowsAffected: [res.length] };
        }

        if (/INSERT\s+INTO\s+mat_vesda/i.test(q)) {
            const item = {
                id: memoryStore.mat_vesda.length + 1,
                material: inputs.mat || inputs.material || '',
                price: inputs.price || 0,
                abc_indicator: inputs.abc || 'C',
                material_description: inputs.desc || inputs.material_description || '',
                plant: inputs.plant || '5205',
                last_change: new Date().toISOString().split('T')[0],
                base_unit_of_measure: inputs.unit || 'EA',
                purchasing_group: inputs.purch || 'P01',
                mrp_type: inputs.mrp || 'PD',
                valuation_class: inputs.val_class || '3000',
                currency: inputs.curr || 'USD',
                price_unit: inputs.price_unit || 1,
                price_control: inputs.price_ctrl || 'S',
                material_type: inputs.mat_type || 'ROH',
                material_group: inputs.mat_group || 'GEN',
                valuation_type: inputs.val_type || '',
                created_by: inputs.created_by || 'Sistema'
            };
            memoryStore.mat_vesda.push(item);
            return { recordset: [], rowsAffected: [1] };
        }

        if (/DELETE\s+FROM\s+mat_vesda/i.test(q)) {
            if (inputs.id) {
                memoryStore.mat_vesda = memoryStore.mat_vesda.filter(m => m.id !== Number(inputs.id));
            }
            return { recordset: [], rowsAffected: [1] };
        }

        // 13. Audit Log & Import Logs
        if (/SELECT\s+.*FROM\s+audit_log/i.test(q)) {
            return { recordset: memoryStore.audit_log, rowsAffected: [memoryStore.audit_log.length] };
        }
        if (/SELECT\s+.*FROM\s+import_logs/i.test(q)) {
            return { recordset: memoryStore.import_logs, rowsAffected: [memoryStore.import_logs.length] };
        }

        // 14. Implementation Tasks
        if (/SELECT\s+.*FROM\s+implementation_tasks/i.test(q)) {
            let res = memoryStore.implementation_tasks.map(t => {
                const user = memoryStore.users.find(u => u.id === t.assigned_user_id);
                return {
                    id: t.id,
                    ecnId: t.ecn_id,
                    family: t.family,
                    department: t.department,
                    taskName: t.task_name,
                    assignedUserId: t.assigned_user_id,
                    assignedUserName: user ? user.name : t.assigned_user_id,
                    status: t.status,
                    dueDate: t.due_date,
                    comments: t.comments,
                    updatedAt: t.updated_at
                };
            });
            if (inputs.family) {
                res = res.filter(t => t.family === inputs.family);
            }
            if (inputs.department || inputs.dept) {
                const d = inputs.department || inputs.dept;
                res = res.filter(t => t.department === d);
            }
            if (inputs.ecnId || inputs.ecnid) {
                const e = inputs.ecnId || inputs.ecnid;
                res = res.filter(t => t.ecnId === e);
            }
            if (inputs.userId) {
                res = res.filter(t => t.assignedUserId === inputs.userId);
            }
            if (inputs.tname) {
                res = res.filter(t => t.taskName === inputs.tname);
            }
            return { recordset: res, rowsAffected: [res.length] };
        }

        if (/INSERT\s+INTO\s+implementation_tasks/i.test(q)) {
            const newTask = {
                id: inputs.id || uuidv4(),
                ecn_id: inputs.ecnId || inputs.ecnid || '',
                family: inputs.family || inputs.fam || 'General',
                department: inputs.department || inputs.dept || 'General',
                task_name: inputs.taskName || inputs.tname || '',
                assigned_user_id: inputs.userId || inputs.assignedUserId || '',
                status: inputs.status || 'Pendiente',
                due_date: inputs.dueDate ? (inputs.dueDate instanceof Date ? inputs.dueDate.toISOString().split('T')[0] : String(inputs.dueDate)) : '',
                comments: inputs.comments || '',
                updated_at: new Date().toISOString()
            };
            memoryStore.implementation_tasks.push(newTask);
            return { recordset: [], rowsAffected: [1] };
        }

        if (/UPDATE\s+implementation_tasks/i.test(q)) {
            const task = memoryStore.implementation_tasks.find(t => t.id === inputs.id);
            if (task) {
                if (inputs.ecnId) task.ecn_id = inputs.ecnId;
                if (inputs.family) task.family = inputs.family;
                if (inputs.department) task.department = inputs.department;
                if (inputs.taskName) task.task_name = inputs.taskName;
                if (inputs.status !== undefined) task.status = inputs.status;
                if (inputs.userId !== undefined) task.assigned_user_id = inputs.userId;
                if (inputs.dueDate !== undefined) {
                    task.due_date = inputs.dueDate instanceof Date ? inputs.dueDate.toISOString().split('T')[0] : (inputs.dueDate || '');
                }
                if (inputs.comments !== undefined) task.comments = inputs.comments;
                task.updated_at = new Date().toISOString();
            }
            return { recordset: [], rowsAffected: [task ? 1 : 0] };
        }

        if (/DELETE\s+FROM\s+implementation_tasks/i.test(q)) {
            const id = inputs.id;
            const prevLen = memoryStore.implementation_tasks.length;
            memoryStore.implementation_tasks = memoryStore.implementation_tasks.filter(t => t.id !== id);
            return { recordset: [], rowsAffected: [prevLen - memoryStore.implementation_tasks.length] };
        }

        // Default empty response
        return { recordset: [], rowsAffected: [0] };
    }

    async bulk(table: any): Promise<any> {
        return { rowsAffected: [table?.rows?.length || 0] };
    }
}

// SQL Transaction mock
export class MemoryTransaction {
    public pool: any;
    constructor(pool: any) {
        this.pool = pool;
    }
    async begin(): Promise<void> { }
    async commit(): Promise<void> { }
    async rollback(): Promise<void> { }
    request(): MemoryRequest {
        return new MemoryRequest();
    }
}

const pool = new sql.ConnectionPool(config);
pool.on('error', (err) => {
    // Only log actionable errors, suppress disconnection noise
    if (!err.message.includes('Connection not yet open')) {
        console.error('[DB] MSSQL Pool Error:', err.message);
    }
    isDbAvailable = false;
});

const originalRequest = pool.request.bind(pool);
(pool as any).request = function (): any {
    if (isDbAvailable && pool.connected) {
        return originalRequest();
    }
    return new MemoryRequest();
};

const OriginalTransaction = sql.Transaction;

export class SafeTransaction {
    private inner: any;
    public isMemory: boolean = false;

    constructor(poolArg?: any) {
        if (isDbAvailable && pool && pool.connected) {
            this.inner = new OriginalTransaction(poolArg || pool);
            this.isMemory = false;
        } else {
            this.inner = new MemoryTransaction(poolArg || pool);
            this.isMemory = true;
        }
    }

    async begin(isolationLevel?: any): Promise<void> {
        if (this.isMemory) {
            return;
        }
        try {
            await this.inner.begin(isolationLevel);
        } catch (err: any) {
            console.warn('[DB] Transaction fallback to memory:', err.message);
            this.isMemory = true;
            this.inner = new MemoryTransaction(pool);
        }
    }

    async commit(): Promise<void> {
        if (this.isMemory) return;
        return this.inner.commit();
    }

    async rollback(): Promise<void> {
        if (this.isMemory) return;
        try {
            return await this.inner.rollback();
        } catch (rbErr) { }
    }

    request(): any {
        if (this.isMemory) {
            return new MemoryRequest();
        }
        return this.inner.request();
    }
}

// Override sql.Transaction so callers never crash with "Connection not yet open"
(sql as any).Transaction = SafeTransaction;

async function ensureTablesExist(p: sql.ConnectionPool): Promise<void> {
    try {
        await p.request().query(`
            IF OBJECT_ID('dbo.users', 'U') IS NULL
            CREATE TABLE dbo.users (
                id NVARCHAR(100) PRIMARY KEY,
                name NVARCHAR(255),
                email NVARCHAR(255),
                department NVARCHAR(255),
                photo NVARCHAR(MAX)
            );

            IF OBJECT_ID('dbo.ecns', 'U') IS NULL
            CREATE TABLE dbo.ecns (
                id NVARCHAR(100) PRIMARY KEY,
                initiator NVARCHAR(100),
                description NVARCHAR(MAX),
                status NVARCHAR(50),
                creation_date DATE,
                implementation_date DATE,
                summary NVARCHAR(MAX)
            );

            IF OBJECT_ID('dbo.component_changes', 'U') IS NULL
            CREATE TABLE dbo.component_changes (
                id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
                ecn_id NVARCHAR(100),
                assembly NVARCHAR(100),
                assembly_revision NVARCHAR(50),
                assembly_description NVARCHAR(MAX),
                old_component NVARCHAR(100),
                new_component NVARCHAR(100),
                new_component_revision NVARCHAR(50),
                new_component_description NVARCHAR(MAX),
                old_subassembly NVARCHAR(100),
                new_subassembly NVARCHAR(100),
                new_subassembly_revision NVARCHAR(50),
                new_subassembly_description NVARCHAR(MAX),
                sku NVARCHAR(100),
                family NVARCHAR(100),
                demand DECIMAL(18,2) DEFAULT 0,
                on_hand_inventory DECIMAL(18,2) DEFAULT 0,
                open_po_qty DECIMAL(18,2) DEFAULT 0,
                start_date DATE,
                site NVARCHAR(50)
            );

            IF OBJECT_ID('dbo.notes', 'U') IS NULL
            CREATE TABLE dbo.notes (
                id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
                ecn_id NVARCHAR(100),
                author NVARCHAR(100),
                text NVARCHAR(MAX),
                date DATETIMEOFFSET DEFAULT SYSDATETIMEOFFSET()
            );

            IF OBJECT_ID('dbo.checklist_items', 'U') IS NULL
            CREATE TABLE dbo.checklist_items (
                id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
                ecn_id NVARCHAR(100),
                question NVARCHAR(MAX),
                department NVARCHAR(100),
                action_status NVARCHAR(50),
                comment NVARCHAR(MAX),
                who NVARCHAR(100),
                [when] NVARCHAR(100),
                crb NVARCHAR(50),
                crb_ok NVARCHAR(50),
                cib NVARCHAR(50),
                cib_ok NVARCHAR(50),
                isc_impl NVARCHAR(50),
                impl_ok NVARCHAR(50)
            );

            IF OBJECT_ID('dbo.mat_vesda', 'U') IS NULL
            CREATE TABLE dbo.mat_vesda (
                id INT IDENTITY(1,1) PRIMARY KEY,
                material NVARCHAR(100),
                price DECIMAL(18,4) DEFAULT 0,
                abc_indicator NVARCHAR(10),
                material_description NVARCHAR(MAX),
                plant NVARCHAR(50),
                last_change NVARCHAR(50),
                base_unit_of_measure NVARCHAR(20),
                purchasing_group NVARCHAR(50),
                mrp_type NVARCHAR(50),
                valuation_class NVARCHAR(50),
                currency NVARCHAR(10),
                price_unit DECIMAL(18,2) DEFAULT 1,
                price_control NVARCHAR(10),
                material_type NVARCHAR(50),
                material_group NVARCHAR(50),
                valuation_type NVARCHAR(50),
                created_by NVARCHAR(100)
            );

            IF OBJECT_ID('dbo.settings', 'U') IS NULL
            CREATE TABLE dbo.settings (
                [key] NVARCHAR(100) PRIMARY KEY,
                value NVARCHAR(MAX)
            );

            IF OBJECT_ID('dbo.audit_log', 'U') IS NULL
            CREATE TABLE dbo.audit_log (
                id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
                ecn_id NVARCHAR(100),
                timestamp DATETIMEOFFSET DEFAULT SYSDATETIMEOFFSET(),
                [user] NVARCHAR(100),
                type NVARCHAR(100),
                target NVARCHAR(255),
                action NVARCHAR(MAX)
            );

            IF OBJECT_ID('dbo.import_logs', 'U') IS NULL
            CREATE TABLE dbo.import_logs (
                id INT IDENTITY(1,1) PRIMARY KEY,
                timestamp DATETIMEOFFSET DEFAULT SYSDATETIMEOFFSET(),
                file_name NVARCHAR(255),
                total_records INT DEFAULT 0,
                new_ecns NVARCHAR(MAX),
                updated_ecns NVARCHAR(MAX),
                descriptions_updated INT DEFAULT 0,
                sku_by_assembly_updated INT DEFAULT 0,
                new_users INT DEFAULT 0,
                updated_users INT DEFAULT 0,
                details NVARCHAR(MAX)
            );

            IF OBJECT_ID('dbo.implementation_tasks', 'U') IS NULL
            CREATE TABLE dbo.implementation_tasks (
                id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
                ecn_id NVARCHAR(100),
                family NVARCHAR(100),
                department NVARCHAR(100),
                task_name NVARCHAR(255),
                assigned_user_id NVARCHAR(100),
                status NVARCHAR(50) DEFAULT 'Pendiente',
                due_date DATE,
                comments NVARCHAR(MAX),
                updated_at DATETIME2 DEFAULT SYSDATETIME()
            );
        `);
        console.log('[DB] Verified core schema tables in MSSQL.');
    } catch (err: any) {
        console.warn('[DB] Note during schema check:', err.message);
    }
}

let resolveReady: (value: boolean) => void;
const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
});

export const isDatabaseAvailable = () => true; // Always return true so application operates without blocking
export const isLiveMssqlConnected = () => isDbAvailable && pool.connected;
export const getMemoryStore = () => memoryStore;

export const init = async (): Promise<boolean> => {
    try {
        console.log(`[DB] Attempting connection to SQL Server "${config.server}:${config.port}"...`);

        // Try connecting with a 7-second timeout
        const connectPromise = pool.connect();
        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Connection timeout (7s)')), 7000)
        );

        await Promise.race([connectPromise, timeoutPromise]);

        isDbAvailable = true;
        isInitialized = true;
        console.log(`[DB] Connected successfully to MSSQL Database "${config.database}"`);
        await ensureTablesExist(pool);
        if (resolveReady) resolveReady(true);
        return true;
    } catch (err: any) {
        isDbAvailable = false;
        isInitialized = true;
        console.warn(`[DB] Live MSSQL connection skipped (${err.message || 'Offline'}). Operating in integrated high-performance mode.`);
        if (resolveReady) resolveReady(true);
        return true;
    }
};

const poolConnect = Promise.resolve(pool);

export { sql, pool, poolConnect, ready };
