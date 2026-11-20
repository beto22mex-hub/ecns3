import { ECN, Assembly, ChecklistItem, User, ImportLogEntry, AuditLog, ComponentChange, AzureAuthConfig, ServerAuthTestResult, GraphUserLookupResult, MaterialItem, ImplementationTask } from '../types';
import { normalizeFamilyData } from './families';


declare global {
    interface ImportMeta {
        env: {
            PROD: boolean;
            [key: string]: any;
        };
    }
}

const getApiBaseUrl = (): string => {
    if (typeof window !== 'undefined' && window.location.pathname.startsWith('/ecns')) {
        return '/ecns/api';
    }
    return '/api';
};

const API_BASE_URL = getApiBaseUrl();



export interface EmailSettings {
    host: string;
    port: number;
    secure?: boolean;
    user: string;
    pass: string;
    from: string;
    fromName: string;
    to: string;
}

// --- Utility Function for API calls ---
const handleResponse = async (response: Response) => {
    if (!response.ok) {
        let errorMessage;
        try {
            const errorData = await response.json();
            errorMessage = errorData.error || JSON.stringify(errorData);
        } catch (e) {
            try {
                errorMessage = await response.text();
            } catch (textErr) {
                errorMessage = response.statusText;
            }
        }
        console.error(`API Error: ${response.status} ${response.statusText}`, errorMessage);
        throw new Error(`Error del servidor: ${response.status} - ${errorMessage}`);
    }
    if (response.status === 204) {
        return null;
    }
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('application/json')) {
        const text = await response.text();
        console.error(`Expected JSON but received ${contentType}. Body sample: ${text.substring(0, 100)}`);
        throw new Error('El servidor no devolvió una respuesta válida (JSON esperado).');
    }
    return normalizeFamilyData(await response.json());
};

const apiFetch = (endpoint: string, options: RequestInit = {}) => {
    return fetch(`${API_BASE_URL}${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers,
        },
    }).then(handleResponse);
};

// --- Data Sanitization ---
const sanitizeEcn = (ecn: any): ECN => {
    return {
        ...ecn,
        changes: ecn.changes || [],
        notes: ecn.notes || [],
        auditLog: ecn.auditLog || [],
        checklist: ecn.checklist || [],
        // Ensure aggregated strings are passed through
        skuList: ecn.skuList || '',
        oldComponentList: ecn.oldComponentList || '',
        newComponentList: ecn.newComponentList || '',
        siteList: ecn.siteList || '',
    };
};

const sanitizeAssembly = (assembly: any): Assembly => {
    return {
        ...assembly,
        description: assembly.description || '',
        bom: (assembly.bom || []).map((item: any) => ({
            ...item,
            description: item.description || '',
            componentId: item.componentId || '',
            ecns: item.ecns || []
        }))
    };
};

// --- ECN Operations ---
export const getEcns = async (filters: any = {}): Promise<ECN[]> => {
    const params = new URLSearchParams();
    if (filters.search) params.append('search', filters.search);
    if (filters.status && filters.status !== 'Todos') params.append('status', filters.status);
    if (filters.timeFilter) params.append('timeFilter', filters.timeFilter);
    if (filters.year && filters.year !== 'All') params.append('year', filters.year);
    if (filters.sortBy) params.append('sortBy', filters.sortBy);
    if (filters.sortDirection) params.append('sortDirection', filters.sortDirection);

    const rawEcns = await apiFetch(`/ecns?${params.toString()}`);
    return Array.isArray(rawEcns) ? rawEcns.map(sanitizeEcn) : [];
};

export const getEcnById = async (id: string): Promise<ECN> => {
    const rawEcn = await apiFetch(`/ecns/${id}`);
    return sanitizeEcn(rawEcn);
};

export interface ComponentChangesDiff {
    added?: ComponentChange[];
    updated?: ComponentChange[];
    deletedIds?: string[];
}

export const updateEcn = async (ecn: ECN, user: string, diff?: ComponentChangesDiff): Promise<any> => {
    return apiFetch(`/ecns/${ecn.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ecn, user, diff }),
    });
};

export const updateEcnSummary = async (ecnId: string, summary: string): Promise<any> => {
    return apiFetch(`/ecns/${ecnId}/summary`, {
        method: 'PUT',
        body: JSON.stringify({ summary }),
    });
};

export const deleteEcn = async (ecnId: string): Promise<any> => {
    return apiFetch(`/ecns/${ecnId}`, { method: 'DELETE' });
};

// --- Note & Checklist Operations ---
export const addNoteToEcn = async (ecnId: string, noteText: string, author: string): Promise<any> => {
    return apiFetch(`/ecns/${ecnId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ text: noteText, author }),
    });
};

export const updateChecklist = async (ecnId: string, checklist: ChecklistItem[], user: string): Promise<any> => {
    return apiFetch(`/ecns/${ecnId}/checklist`, {
        method: 'PUT',
        body: JSON.stringify({ checklist, user }),
    });
};

// --- User Operations ---
export const getUsers = async (): Promise<User[]> => {
    return apiFetch('/users');
};

export const updateUser = async (user: User): Promise<any> => {
    return apiFetch(`/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify(user),
    });
};

// --- Component & Assembly Operations ---
export const getAssemblies = async (): Promise<Assembly[]> => {
    const raw = await apiFetch('/assemblies');
    return Array.isArray(raw) ? raw.map(sanitizeAssembly) : [];
};

export const updateComponentDescription = async (componentId: string, description: string): Promise<any> => {
    return apiFetch(`/components/description`, {
        method: 'PUT',
        body: JSON.stringify({ componentId, description }),
    });
};

// --- Log Operations ---
export const getImportLogs = async (): Promise<ImportLogEntry[]> => {
    return apiFetch('/import-logs');
};

export const getAuditLogs = async (): Promise<AuditLog[]> => {
    return apiFetch('/audit-logs');
};


// --- Import Operations ---

export interface ImportProgressInfo {
    current: number;
    total: number;
    percent: number;
    stage: string;
    newCount?: number;
    updatedCount?: number;
}

export const upsertEcns = async (
    ecns: ECN[], 
    fileName: string, 
    onProgress?: (progress: ImportProgressInfo) => void
): Promise<any> => {
    const BATCH_SIZE = 50;
    if (ecns.length <= BATCH_SIZE || !onProgress) {
        if (onProgress) {
            onProgress({ current: 0, total: ecns.length, percent: 10, stage: 'Enviando datos al servidor...' });
        }
        const res = await apiFetch('/import/sap-upsert', {
            method: 'POST',
            body: JSON.stringify({ ecns, fileName }),
        });
        if (onProgress) {
            onProgress({ 
                current: ecns.length, 
                total: ecns.length, 
                percent: 100, 
                stage: 'Importación completada',
                newCount: res.newCount,
                updatedCount: res.updatedCount
            });
        }
        return res;
    }

    let totalNew = 0;
    let totalUpdated = 0;
    const totalEcns = ecns.length;
    let processed = 0;
    const totalBatches = Math.ceil(totalEcns / BATCH_SIZE);

    for (let i = 0; i < ecns.length; i += BATCH_SIZE) {
        const batch = ecns.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const currentPercent = Math.round((processed / totalEcns) * 100);

        onProgress({
            current: processed,
            total: totalEcns,
            percent: Math.max(5, currentPercent),
            stage: `Guardando en base de datos: Lote ${batchNum} de ${totalBatches} (${processed} de ${totalEcns} ECNs)...`,
            newCount: totalNew,
            updatedCount: totalUpdated
        });

        const res = await apiFetch('/import/sap-upsert', {
            method: 'POST',
            body: JSON.stringify({ ecns: batch, fileName }),
        });

        totalNew += (res.newCount || 0);
        totalUpdated += (res.updatedCount || 0);
        processed += batch.length;

        const updatedPercent = Math.round((processed / totalEcns) * 100);
        onProgress({
            current: processed,
            total: totalEcns,
            percent: updatedPercent,
            stage: processed >= totalEcns 
                ? `Finalizando importación... (${totalEcns} ECNs)` 
                : `Procesados ${processed} de ${totalEcns} ECNs (Lote ${batchNum}/${totalBatches})...`,
            newCount: totalNew,
            updatedCount: totalUpdated
        });
    }

    return {
        success: true,
        newCount: totalNew,
        updatedCount: totalUpdated,
        totalRecords: totalEcns
    };
};

export const importDescriptions = async (data: { ECN: string, Description: string }[], fileName: string): Promise<any> => {
    return apiFetch('/import/descriptions', {
        method: 'POST',
        body: JSON.stringify({ data, fileName }),
    });
};

export const importSkuFamily = async (data: ({ Assembly: string, SKU: string, Family: string } | { Product: string, SBU: string, SMD?: string })[], fileName: string): Promise<any> => {
    return apiFetch('/import/sku-family', {
        method: 'POST',
        body: JSON.stringify({ data, fileName }),
    });
};

export const importUsers = async (users: User[], fileName: string): Promise<any> => {
    return apiFetch('/import/users', {
        method: 'POST',
        body: JSON.stringify({ users, fileName }),
    });
};

export const getMatVesda = async (): Promise<any[]> => {
    return apiFetch('/mat-vesda');
};

export const importMatVesda = async (data: any[]): Promise<any> => {
    return apiFetch('/mat-vesda/import', {
        method: 'POST',
        body: JSON.stringify({ data }),
    });
};

// --- Settings and Email Operations ---
export const getEmailSettings = async (): Promise<Partial<EmailSettings>> => {
    return apiFetch('/settings/email');
};

export const saveEmailSettings = async (settings: EmailSettings): Promise<any> => {
    return apiFetch('/settings/email', {
        method: 'POST',
        body: JSON.stringify(settings),
    });
};

export const testEmailSettings = async (settings: EmailSettings): Promise<any> => {
    return apiFetch('/settings/email/test', {
        method: 'POST',
        body: JSON.stringify(settings),
    });
};

export const sendEcnStatusUpdate = async (ecn: ECN): Promise<any> => {
    return apiFetch('/email/notification/ecn-status-change', {
        method: 'POST',
        body: JSON.stringify(ecn),
    });
};

export const sendEcnImplementedNotification = async (ecn: ECN): Promise<any> => {
    return apiFetch('/notify/ecn-implemented', {
        method: 'POST',
        body: JSON.stringify(ecn),
    });
};

export const sendWeeklySummary = async (): Promise<any> => {
    return apiFetch('/email/weekly-summary', {
        method: 'POST',
    });
};

// --- Migration & DB Management ---
export const clearAllData = async (): Promise<any> => {
    return apiFetch('/database', {
        method: 'DELETE'
    });
};

export const migrateFromPostgres = async (pgConfig: any): Promise<any> => {
    return apiFetch('/database/migrate-from-postgres', {
        method: 'POST',
        body: JSON.stringify({ pgConfig }),
    });
};

export const migrateFromPostgresStream = async (pgConfig: any): Promise<Response> => {
    // Cuando usamos proxy o mismo origen, la URL base ya incluye el puerto correcto
    const url = import.meta.env.PROD
        ? `${window.location.origin}/api/database/migrate-from-postgres`
        : `http://localhost:3000/api/database/migrate-from-postgres`;

    console.log(`[Migration] Iniciando conexión a: ${url}`);
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pgConfig }),
    });
};

export const migrateFromApiStream = async (sourceUrl: string): Promise<Response> => {
    console.log(`[Migration] Iniciando migración desde API remota: ${sourceUrl}`);
    const url = import.meta.env.PROD
        ? `${window.location.origin}/api/database/migrate-from-api`
        : `http://localhost:3000/api/database/migrate-from-api`;

    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceUrl }),
    });
};

export const generateEcnSummary = async (ecnId: string): Promise<string> => {
    const result = await apiFetch(`/ecns/${ecnId}/generate-summary`, { method: 'POST' });
    return result.summary;
};

export const processZpp = async (params: { initialDate: string; finalDate: string; plants: string[] }): Promise<any> => {
    const resp = await fetch(`${API_BASE_URL}/sap/process-zpp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });

    if (resp.status === 412) {
        const body = await resp.json().catch(() => ({}));
        const err: any = new Error(body.error || 'SAP no session');
        err.status = 412;
        err.reason = body.reason;
        err.logs = body.logs;
        throw err;
    }

    return handleResponse(resp as any);
};

export const runVbaSync = async (params: { startDate?: string; endDate?: string; plant?: string; initialDate?: string; finalDate?: string; plants?: string[]; records?: any[] }): Promise<any> => {
    const initialDate = params.initialDate || params.startDate;
    const finalDate = params.finalDate || params.endDate;
    const plants = params.plants || (params.plant ? [params.plant] : ['5205']);

    const resp = await fetch(`${API_BASE_URL}/sap/execute-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ...params,
            startDate: initialDate,
            endDate: finalDate,
            initialDate,
            finalDate,
            plants,
            plant: params.plant || plants[0] || '5205'
        }),
    });

    if (resp.status === 412) {
        const body = await resp.json().catch(() => ({}));
        const err: any = new Error(body.error || 'SAP no session');
        err.status = 412;
        err.reason = body.reason;
        err.logs = body.logs;
        throw err;
    }

    return handleResponse(resp as any);
};

// Preview: extract SAP data without saving to DB; returns raw records for mapping UI
export const runVbaSyncPreview = async (params: { startDate?: string; endDate?: string; plant?: string; initialDate?: string; finalDate?: string; plants?: string[] }): Promise<any> => {
    const initialDate = params.initialDate || params.startDate;
    const finalDate = params.finalDate || params.endDate;
    const plants = params.plants || (params.plant ? [params.plant] : ['5205']);

    const resp = await fetch(`${API_BASE_URL}/sap/preview-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ...params,
            startDate: initialDate,
            endDate: finalDate,
            initialDate,
            finalDate,
            plants,
            plant: params.plant || plants[0] || '5205'
        }),
    });

    if (resp.status === 412) {
        const body = await resp.json().catch(() => ({}));
        const err: any = new Error(body.error || 'SAP no session');
        err.status = 412;
        err.reason = body.reason;
        err.logs = body.logs;
        throw err;
    }

    return handleResponse(resp as any);
};

export const executeSapPowerShellSync = async (params: { startDate?: string; endDate?: string; plant?: string; autoImport?: boolean }): Promise<any> => {
    return apiFetch('/sap/execute-sync', {
        method: 'POST',
        body: JSON.stringify(params),
    });
};

export const fetchSapEcnDescription = async (params: { ecro: string; type: 'IQS3' | 'CC03' | string }): Promise<{ success: boolean; description?: string; mode?: string; error?: string }> => {
    return apiFetch('/sap/fetch', {
        method: 'POST',
        body: JSON.stringify(params),
    });
};

export const updateMissingSapDescriptions = async (params?: string | {
    ecnId?: string;
    description?: string;
    pattern?: string;
    mask?: string;
    ecns?: string[];
    updates?: Array<{ id?: string; ecnId?: string; description: string }>;
    records?: any[];
    rawText?: string;
}): Promise<{
    success: boolean;
    message: string;
    totalFound: number;
    updatedCount: number;
    updatedEcns?: string[];
    description?: string;
    error?: string;
    missingEcns?: string[];
    mode?: string;
}> => {
    let body = {};
    if (typeof params === 'string') {
        const trimmed = params.trim();
        if (trimmed.includes('*') || trimmed.includes('%')) {
            body = { pattern: trimmed };
        } else if (trimmed) {
            body = { ecnId: trimmed };
        }
    } else if (params && typeof params === 'object') {
        body = params;
    }
    return apiFetch('/sap/update-missing-descriptions', {
        method: 'POST',
        body: JSON.stringify(body),
    });
};

export const syncIqs3Descriptions = async (params: {
    mask?: string;
    allExisting?: boolean;
    ecns?: string[];
}): Promise<{
    success: boolean;
    message: string;
    totalFound: number;
    updatedCount: number;
    updatedEcns?: string[];
    missingEcns?: string[];
    mode?: string;
    ecns?: string[];
    downloadVbsUrl?: string;
    downloadBatUrl?: string;
    webguiUrl?: string;
    error?: string;
}> => {
    return apiFetch('/sap/sync-iqs3-descriptions', {
        method: 'POST',
        body: JSON.stringify(params),
    });
};

export const getSapBridgeStatus = async (): Promise<{ status: string; platform: string; powershellAvailable: boolean }> => {
    return apiFetch('/sap/status');
};


export const getSetting = async (key: string): Promise<string | null> => {
    try {
        const result = await apiFetch(`/settings/${encodeURIComponent(key)}`);
        return result?.value ?? null;
    } catch {
        return null;
    }
};

export const saveSetting = async (key: string, value: string): Promise<void> => {
    await apiFetch('/settings', {
        method: 'POST',
        body: JSON.stringify({ key, value }),
    });
};

export const exportDb = async (): Promise<File> => {
    throw new Error("Exporting the database is no longer supported with the API backend.");
};

// --- Azure AD / Microsoft Entra ID Authentication ---

export const getAzureAuthConfig = async (): Promise<AzureAuthConfig> => {
    return apiFetch('/auth/azure/config');
};

export const getAzureAuthUrl = async (): Promise<{ url: string; redirectUri: string }> => {
    return apiFetch('/auth/azure/url');
};

export const getCurrentUser = async (): Promise<{ user: User | null; isAuthenticated: boolean }> => {
    try {
        return await apiFetch('/auth/me');
    } catch {
        return { user: null, isAuthenticated: false };
    }
};

export const logoutAzure = async (): Promise<{ success: boolean }> => {
    return apiFetch('/auth/logout', { method: 'POST' });
};

export const saveAzureConfig = async (config: {
    authEnabled?: boolean;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
    grantType?: 'authorization_code' | 'client_credentials' | 'both';
    serverToServerEnabled?: boolean;
}): Promise<{ message: string; config: AzureAuthConfig }> => {
    return apiFetch('/auth/azure/config', {
        method: 'POST',
        body: JSON.stringify(config),
    });
};

export const testServerToServerAuth = async (config?: {
    clientId?: string;
    clientSecret?: string;
    tenantId?: string;
    scope?: string;
}): Promise<ServerAuthTestResult> => {
    return apiFetch('/auth/azure/server-to-server/test', {
        method: 'POST',
        body: JSON.stringify(config || {}),
    });
};

export const connectServerToServer = async (config?: {
    clientId?: string;
    clientSecret?: string;
    tenantId?: string;
}): Promise<{ success: boolean; user: User; message: string }> => {
    return apiFetch('/auth/azure/server-to-server/connect', {
        method: 'POST',
        body: JSON.stringify(config || {}),
    });
};

export const lookupAzureUser = async (query: string, customConfig?: any): Promise<GraphUserLookupResult> => {
    return apiFetch('/auth/azure/server-to-server/lookup-user', {
        method: 'POST',
        body: JSON.stringify({ query, customConfig }),
    });
};

export const loginWithAzureServerToServerUser = async (params: {
    emailOrId: string;
    name?: string;
    department?: string;
    jobTitle?: string;
    customConfig?: any;
}): Promise<{ success: boolean; user: User; message: string; source?: string; permissionsNote?: string }> => {
    return apiFetch('/auth/azure/server-to-server/login-user', {
        method: 'POST',
        body: JSON.stringify(params),
    });
};

export const testAzureLoginDirect = async (user: Partial<User>): Promise<{ user: User; message: string }> => {
    return apiFetch('/auth/azure/direct-login', {
        method: 'POST',
        body: JSON.stringify(user),
    });
};

export const getMaterials = async (): Promise<MaterialItem[]> => {
    return apiFetch('/materials');
};

export const getAssemblySkuFamily = async (): Promise<any[]> => {
    return apiFetch('/assembly-sku-family');
};

export const updateAssemblySkuFamily = async (assembly: string, sku: string, family: string): Promise<any> => {
    return apiFetch('/assembly-sku-family', {
        method: 'PUT',
        body: JSON.stringify({ assembly, sku, family }),
    });
};

export const getImplementationTasks = async (filters: { family?: string; department?: string; ecnId?: string; userId?: string } = {}): Promise<ImplementationTask[]> => {
    const params = new URLSearchParams();
    if (filters.family) params.append('family', filters.family);
    if (filters.department) params.append('department', filters.department);
    if (filters.ecnId) params.append('ecnId', filters.ecnId);
    if (filters.userId) params.append('userId', filters.userId);
    return apiFetch(`/implementation-tasks?${params.toString()}`);
};

export const updateImplementationTask = async (taskId: string, data: Partial<ImplementationTask>): Promise<any> => {
    return apiFetch(`/implementation-tasks/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
};

export const createImplementationTask = async (data: Partial<ImplementationTask>): Promise<any> => {
    return apiFetch('/implementation-tasks', {
        method: 'POST',
        body: JSON.stringify(data),
    });
};

export const deleteImplementationTask = async (taskId: string): Promise<any> => {
    return apiFetch(`/implementation-tasks/${taskId}`, {
        method: 'DELETE',
    });
};

export const getSuggestedTasks = async (): Promise<{ department: string; taskName: string }[]> => {
    return apiFetch('/implementation-tasks/suggestions');
};




