
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { ECN, ECNStatus, ImportLogEntry, ComponentChange, AuditLog } from '../types';
import * as api from '../services/api';
import { Card, Button, Toast, StatusBadge, ConfirmationModal, Modal, ImportProgressModal } from './ui';
import { SapWebGuiImporter } from './SapWebGuiImporter';
import { SapDescriptionsSyncModal } from './SapDescriptionsSyncModal';

// Props for the main component
interface ChangesProps {
    onDataChange: () => void;
}

const MAPPABLE_FIELDS: Record<string, { label: string, required?: boolean, aliases?: string[] }> = {
    ecn: { label: 'ECN', required: true, aliases: ['change no.', 'ecro', 'ecno', 'ecn no', 'ecn no.', 'ecn #', 'ecn code'] },
    assembly: { label: 'Assembly', aliases: ['assembly', 'ensamble'] },
    oldComponent: { label: 'OldComponent', aliases: ['component', 'bom item material', 'componente'] },
    newComponent: { label: 'NewComponent', aliases: ['start material', 'material', 'nuevo componente'] },
    startDate: { label: 'StartDate', aliases: ['start date', 'valid from', 'fecha inicio', 'fecha de inicio', 'valid fr', 'inicio'] },
    stopDate: { label: 'StopDate', aliases: ['stop date', 'fecha fin', 'fin'] },
    createdBy: { label: 'CreatedBy', aliases: ['created by', 'initiator', 'iniciador', 'creado por'] },
    demand: { label: 'Demand', aliases: ['demand', 'demanda'] },
    onHandInventory: { label: 'OnHandInventory', aliases: ['on hand inventory', 'on hand', 'inventario', 'stock'] },
    openPoQty: { label: 'OpenPoQty', aliases: ['open po qty', 'open po', 'po qty', 'pendientes po'] },
    assemblyDescription: { label: 'AssemblyDescription', aliases: ['description', 'object description', 'descripción', 'descrip', 'assembly description', 'descripción ensamble'] },
    notes: { label: 'Notes', aliases: ['notes', 'notas', 'comentarios'] },
    assemblyRevision: { label: 'AssemblyRevision', aliases: ['revlvl', 'revisión', 'rev', 'rev no', 'rev. no', 'rev no.'] },
    startMaterialRevision: { label: 'StartMaterialRevision', aliases: ['mat rev', 'rev no1', 'rev no.1', 'rev no_2', 'rev no 2', 'rev no. 2', 'rev no2', 'rev_no_2', 'material revision', 'start material revision'] },
    startMaterialDescription: { label: 'StartMaterialDescription', aliases: ['material description', 'descripción material', 'start material description'] },
    createdOn: { label: 'CreatedOn', aliases: ['created on', 'fecha creacion', 'fecha de creación', 'creación'] },
    sku: { label: 'SKU / SKUs Afectados', aliases: ['sku', 'skus', 'affected sku', 'sku afectado', 'skus afectados', 'material sku'] },
    family: { label: 'Familia', aliases: ['family', 'familia', 'product family'] },
    plant: { label: 'Planta (Plant)', aliases: ['plant', 'planta', 'plt', 'site', 'centro'] }
};

const exportToCsv = (filename: string, rows: object[]) => {
    if (!rows || !rows.length) {
        return;
    }
    const separator = ',';
    const keys = Object.keys(rows[0]);
    const csvContent =
        keys.join(separator) +
        '\n' +
        rows.map(row => {
            return keys.map(k => {
                let cell = (row as any)[k] === null || (row as any)[k] === undefined ? '' : (row as any)[k];
                cell = cell instanceof Date
                    ? cell.toLocaleString()
                    : cell.toString().replace(/"/g, '""');
                if (cell.search(/("|,|\n)/g) >= 0) {
                    cell = `"${cell}"`;
                }
                return cell;
            }).join(separator);
        }).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    if (link.download !== undefined) {
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
};


// --- Importer for SAP Report ---
const SapReportImporter: React.FC<{ onImport: () => void, setNotification: (n: { message: string, type: 'success' | 'error' } | null) => void }> = ({ onImport, setNotification }) => {
    const [step, setStep] = useState<'select' | 'map'>('select');
    const [fileName, setFileName] = useState<string | null>(null);
    const [headers, setHeaders] = useState<string[]>([]);
    const [jsonData, setJsonData] = useState<any[]>([]);
    const [mappings, setMappings] = useState<Record<string, string>>({});
    const [isLoading, setIsLoading] = useState(false);
    const [isOtherSite, setIsOtherSite] = useState(false);
    const [selectedSite, setSelectedSite] = useState<string>('5205');
    const [showSiteModal, setShowSiteModal] = useState(false);
    const [importProgress, setImportProgress] = useState<{
        percent: number;
        stage: string;
        current?: number;
        total?: number;
        newCount?: number;
        updatedCount?: number;
    } | null>(null);

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setIsLoading(true);
        setNotification(null);
        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data, { cellDates: true });

            // Prefer sheet named 'Output' if available, otherwise default to first sheet
            const outputSheetName = workbook.SheetNames.find(s => s.trim().toLowerCase() === 'output');
            const sheetName = outputSheetName || workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];

            const allRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null }) as any[][];
            if (allRows.length < 1) {
                throw new Error("El archivo está vacío o no contiene encabezados.");
            }

            // Dynamically detect header row by scanning first 15 rows for key column keywords
            let headerRowIndex = 0;
            const keyHeaders = ['ecn', 'ecno', 'change no.', 'assembly', 'start material', 'component', 'plant', 'created by'];
            for (let i = 0; i < Math.min(15, allRows.length); i++) {
                const rowValues = (allRows[i] || []).map(v => String(v || '').trim().toLowerCase());
                const matchCount = keyHeaders.filter(kh => rowValues.includes(kh)).length;
                if (matchCount >= 2) {
                    headerRowIndex = i;
                    break;
                }
            }

            // Create unique headers to handle duplicates (e.g., "Rev No" appearing twice)
            const rawHeaders = (allRows[headerRowIndex] || []).map(h => String(h || '').trim());
            const parsedHeaders: string[] = [];
            const headerCounts: Record<string, number> = {};

            rawHeaders.forEach(header => {
                if (!header) return; // Skip empty headers
                if (headerCounts[header]) {
                    headerCounts[header]++;
                    parsedHeaders.push(`${header}_${headerCounts[header]}`);
                } else {
                    headerCounts[header] = 1;
                    parsedHeaders.push(header);
                }
            });

            // Slice raw data starting after the detected header row
            const rawData = allRows.slice(headerRowIndex + 1);

            const parsedData = rawData.map(row => {
                const rowObj: any = {};
                parsedHeaders.forEach((header, index) => {
                    rowObj[header] = row[index];
                });
                return rowObj;
            });

            // Auto-mapping logic
            const initialMappings: Record<string, string> = {};
            for (const key in MAPPABLE_FIELDS) {
                const field = MAPPABLE_FIELDS[key];
                const allAliases = [field.label.toLowerCase(), ...(field.aliases || [])];

                // Try to find exact match first (ignoring the _number suffix we added)
                const foundHeader = parsedHeaders.find(h => {
                    const originalHeader = h.replace(/_\d+$/, '').toLowerCase();
                    return allAliases.includes(originalHeader);
                });

                if (foundHeader) {
                    initialMappings[key] = foundHeader;
                }
            }

            setHeaders(parsedHeaders);
            setJsonData(parsedData);
            setMappings(initialMappings);
            setFileName(file.name);
            setStep('map');

        } catch (err) {
            setNotification({ message: (err as Error).message, type: 'error' });
            handleCancel();
        } finally {
            setIsLoading(false);
            event.target.value = '';
        }
    };

    const handleMappingChange = (fieldKey: string, selectedHeader: string) => {
        setMappings(prev => ({ ...prev, [fieldKey]: selectedHeader }));
    };

    const handleCancel = () => {
        setStep('select');
        setFileName(null);
        setHeaders([]);
        setJsonData([]);
        setMappings({});
        setIsOtherSite(false);
        setShowSiteModal(false);
    };

    const parseDate = (dateInput: any): string | null => {
        if (!dateInput) return null;

        // Case 1: Already a valid Date object
        if (dateInput instanceof Date && !isNaN(dateInput.getTime())) {
            const year = dateInput.getFullYear();
            const month = dateInput.getMonth();
            const day = dateInput.getDate();
            const utcDate = new Date(Date.UTC(year, month, day));
            return utcDate.toISOString().split('T')[0];
        }

        // Case 2: Excel serial number
        if (typeof dateInput === 'number' && dateInput > 1) {
            const excelEpoch = new Date(Date.UTC(1899, 11, 30));
            const date = new Date(excelEpoch.getTime() + dateInput * 24 * 60 * 60 * 1000);
            if (!isNaN(date.getTime())) {
                return date.toISOString().split('T')[0];
            }
        }

        // Case 3: String input
        if (typeof dateInput === 'string') {
            const trimmedDate = dateInput.trim().split('T')[0].split(' ')[0];
            let parts;
            let year, month, day;

            // YYYY-MM-DD
            parts = trimmedDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
            if (parts) {
                year = parseInt(parts[1], 10); month = parseInt(parts[2], 10) - 1; day = parseInt(parts[3], 10);
            }
            // M/D/YYYY or MM/DD/YYYY (Windows locale from SAP Excel export)
            if (!parts) {
                parts = trimmedDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                if (parts) { year = parseInt(parts[3], 10); month = parseInt(parts[1], 10) - 1; day = parseInt(parts[2], 10); }
            }
            // DD.MM.YYYY (SAP format)
            if (!parts) {
                parts = trimmedDate.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
                if (parts) { year = parseInt(parts[3], 10); month = parseInt(parts[2], 10) - 1; day = parseInt(parts[1], 10); }
            }

            if (year! > 1900 && month! >= 0 && month! <= 11 && day! >= 1 && day! <= 31) {
                const utcDate = new Date(Date.UTC(year!, month!, day!));
                if (utcDate.getUTCFullYear() === year && utcDate.getUTCMonth() === month && utcDate.getUTCDate() === day) {
                    return utcDate.toISOString().split('T')[0];
                }
            }
        }
        return null;
    };


    const handleProcessImport = async () => {
        if (isOtherSite && !showSiteModal) {
            setShowSiteModal(true);
            return;
        }
        setShowSiteModal(false);
        setIsLoading(true);
        setNotification(null);
        setImportProgress({
            percent: 5,
            stage: 'Consultando ECNs existentes en la base de datos...',
            current: 0,
            total: jsonData.length
        });
        try {
            const existingEcns = await api.getEcns({ timeFilter: 'Todos' });

            let vesdaMaterials: any[] = [];
            if (isOtherSite) {
                setImportProgress({
                    percent: 15,
                    stage: 'Consultando catálogo de materiales VESDA...',
                    current: 0,
                    total: jsonData.length
                });
                vesdaMaterials = await api.getMatVesda();
            }

            setImportProgress({
                percent: 25,
                stage: 'Analizando y estructurando cambios de componentes...',
                current: 0,
                total: jsonData.length
            });

            // Create a lookup map for faster access
            // Storing the actual ECN object reference to modify if needed, but we track changes specifically
            const existingEcnsMap = new Map(existingEcns.map(e => [e.id, e]));

            // Map to track ECNs that actually need to be sent to the backend (New or Updated)
            const ecnsToUpsertMap = new Map<string, ECN>();

            const todayStr = new Date().toISOString().split('T')[0];
            const currentSite = isOtherSite ? selectedSite : '5205';

            jsonData.forEach(row => {
                // 1. Strict filter: Ignore any record where Plant is 5201
                if (mappings.plant && row[mappings.plant] !== undefined && row[mappings.plant] !== null) {
                    const plantVal = String(row[mappings.plant]).trim();
                    if (plantVal === '5201') {
                        return; // Skip record
                    }
                }

                const ecnId = String(row[mappings.ecn] || '').trim();
                if (!ecnId) return;

                const assembly = String(row[mappings.assembly] || '').trim();
                const oldComponent = String(row[mappings.oldComponent] || '').trim();
                const newComponent = String(row[mappings.newComponent] || '').trim();

                if (isOtherSite) {
                    const isAllowed = vesdaMaterials.some(m =>
                        (m.material && m.material.trim() === assembly) ||
                        (m.material && m.material.trim() === oldComponent) ||
                        (m.material && m.material.trim() === newComponent)
                    );
                    if (!isAllowed) return; // Skip if not in MAT_VESDA
                }

                // Determine row site from plant column or selected site
                let rowSite = currentSite;
                if (mappings.plant && row[mappings.plant]) {
                    const pVal = String(row[mappings.plant]).trim();
                    if (pVal) rowSite = pVal;
                }

                // Get existing ECN from memory or from the batch we are building
                let ecn = ecnsToUpsertMap.get(ecnId);

                // If not in batch, check if it exists in DB
                let isNewEcn = false;
                if (!ecn) {
                    const existing = existingEcnsMap.get(ecnId);
                    if (existing) {
                        // Clone existing to modify safely
                        ecn = JSON.parse(JSON.stringify(existing));
                    } else {
                        // New ECN
                        isNewEcn = true;
                        ecn = {
                            id: ecnId,
                            initiator: String(row[mappings.createdBy] || 'Sistema'),
                            description: String(row[mappings.assemblyDescription] || `ECN importado ${ecnId}`),
                            status: ECNStatus.Pending,
                            creationDate: parseDate(row[mappings.createdOn]) || todayStr,
                            implementationDate: '',
                            daysRemaining: 0,
                            changes: [], notes: [], auditLog: [], checklist: []
                        };
                    }
                }

                if (!ecn) return; // Should not happen

                // Extract notes if present in row
                const noteText = mappings.notes && row[mappings.notes] ? String(row[mappings.notes]).trim() : '';
                let noteAdded = false;
                if (noteText) {
                    if (!ecn.notes) ecn.notes = [];
                    const alreadyHasNote = ecn.notes.some(n => n.text === noteText);
                    if (!alreadyHasNote) {
                        ecn.notes.push({
                            id: `note-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
                            author: String(row[mappings.createdBy] || 'Sistema'),
                            text: noteText,
                            date: todayStr
                        });
                        noteAdded = true;
                    }
                }

                const startDate = parseDate(row[mappings.startDate]);
                if (!startDate) return; // Skip components without valid start date

                const newDemand = Number(row[mappings.demand]) || 0;
                const newOnHand = Number(row[mappings.onHandInventory]) || 0;
                const newOpenPo = Number(row[mappings.openPoQty]) || 0;
                const skuVal = mappings.sku && row[mappings.sku] ? String(row[mappings.sku]).trim() : undefined;
                const familyVal = mappings.family && row[mappings.family] ? String(row[mappings.family]).trim() : (isOtherSite ? 'VESDA' : undefined);

                const newChangeValues: ComponentChange = {
                    id: ``,
                    assembly: String(row[mappings.assembly] || ''),
                    oldComponent: String(row[mappings.oldComponent] || ''),
                    newComponent: String(row[mappings.newComponent] || ''),
                    startDate,
                    demand: newDemand,
                    onHandInventory: newOnHand,
                    openPoQty: newOpenPo,
                    assemblyDescription: String(row[mappings.assemblyDescription] || ''),
                    newComponentDescription: String(row[mappings.startMaterialDescription] || ''),
                    newComponentRevision: String(row[mappings.startMaterialRevision] || ''),
                    assemblyRevision: String(row[mappings.assemblyRevision] || ''),
                    sku: skuVal,
                    family: familyVal,
                    site: rowSite
                };

                const existingChangeIndex = ecn.changes.findIndex(c =>
                    c.assembly === newChangeValues.assembly &&
                    c.oldComponent === newChangeValues.oldComponent &&
                    c.newComponent === newChangeValues.newComponent &&
                    c.site === newChangeValues.site
                );

                let componentChanged = false;

                if (existingChangeIndex > -1) {
                    // Check if critical fields changed
                    const existingChange = ecn.changes[existingChangeIndex];

                    // Normalize dates for string comparison
                    const existDate = existingChange.startDate ? existingChange.startDate.split('T')[0] : '';
                    const newDate = newChangeValues.startDate.split('T')[0];

                    const isDateChanged = existDate !== newDate;
                    const isDemandChanged = Number(existingChange.demand) !== newDemand;
                    const isOnHandChanged = Number(existingChange.onHandInventory) !== newOnHand;
                    const isPoChanged = Number(existingChange.openPoQty) !== newOpenPo;
                    const isFamilyChanged = familyVal !== undefined && existingChange.family !== familyVal;
                    const isSkuChanged = skuVal !== undefined && existingChange.sku !== skuVal;

                    if (isDateChanged || isDemandChanged || isOnHandChanged || isPoChanged || isFamilyChanged || isSkuChanged) {
                        // If date changed and new date is in the future, set ECN to Pending
                        if (isDateChanged && newDate > todayStr) {
                            ecn.status = ECNStatus.Pending;
                        }

                        // Update the component in the ECN object
                        existingChange.startDate = newChangeValues.startDate;
                        existingChange.demand = newDemand;
                        existingChange.onHandInventory = newOnHand;
                        existingChange.openPoQty = newOpenPo;
                        if (familyVal !== undefined) existingChange.family = familyVal;
                        if (skuVal !== undefined) existingChange.sku = skuVal;

                        // Also update descriptions & revisions if available in new data
                        if (newChangeValues.assemblyDescription) existingChange.assemblyDescription = newChangeValues.assemblyDescription;
                        if (newChangeValues.newComponentDescription) existingChange.newComponentDescription = newChangeValues.newComponentDescription;
                        if (newChangeValues.newComponentRevision) existingChange.newComponentRevision = newChangeValues.newComponentRevision;
                        if (newChangeValues.assemblyRevision) existingChange.assemblyRevision = newChangeValues.assemblyRevision;

                        componentChanged = true;
                    }
                } else {
                    // New component for this ECN
                    // If new component has a future date, set ECN to Pending
                    const newDate = newChangeValues.startDate.split('T')[0];
                    if (newDate > todayStr) {
                        ecn.status = ECNStatus.Pending;
                    }

                    ecn.changes.push(newChangeValues);
                    componentChanged = true;
                }

                // If it's a new ECN, we must save it.
                // If it's an existing ECN, we save it if a component changed, was added, or a note was added.
                if (isNewEcn || componentChanged || noteAdded) {
                    ecnsToUpsertMap.set(ecnId, ecn);
                }
            });

            const finalEcnsToUpsert = Array.from(ecnsToUpsertMap.values());

            if (finalEcnsToUpsert.length === 0) {
                setNotification({ message: 'No se encontraron cambios nuevos en el archivo. La base de datos está actualizada.', type: 'success' });
                handleCancel();
                setIsLoading(false);
                setImportProgress(null);
                return;
            }

            // Recalculate Logic for updated ECNs
            const todayDate = new Date();
            todayDate.setUTCHours(0, 0, 0, 0);

            finalEcnsToUpsert.forEach(ecn => {
                if (ecn.status === ECNStatus.Canceled) return;

                if (ecn.changes.length > 0) {
                    let allDatesArePastOrPresent = true;
                    let allDatesAreFuture = true;
                    let latestDate = new Date(0);
                    let hasAtLeastOneValidDate = false;

                    for (const change of ecn.changes) {
                        if (!change.startDate) {
                            allDatesArePastOrPresent = false;
                            continue;
                        }
                        hasAtLeastOneValidDate = true;
                        const changeDate = new Date(change.startDate);
                        const changeDateUTC = new Date(Date.UTC(changeDate.getUTCFullYear(), changeDate.getUTCMonth(), changeDate.getUTCDate()));

                        if (changeDateUTC > todayDate) {
                            allDatesArePastOrPresent = false;
                        } else {
                            allDatesAreFuture = false;
                        }

                        if (changeDateUTC > latestDate) latestDate = changeDateUTC;
                    }

                    ecn.implementationDate = hasAtLeastOneValidDate ? latestDate.toISOString().split('T')[0] : '';

                    if (hasAtLeastOneValidDate) {
                        if (allDatesArePastOrPresent) {
                            ecn.status = ECNStatus.Implemented;
                        } else if (allDatesAreFuture) {
                            ecn.status = ECNStatus.Pending;
                        } else {
                            ecn.status = ECNStatus.PartialImplemented;
                        }
                    } else {
                        ecn.status = ECNStatus.Pending;
                    }
                } else {
                    ecn.status = ECNStatus.Pending;
                    ecn.implementationDate = '';
                }
            });

            setImportProgress({
                percent: 40,
                stage: `Guardando ${finalEcnsToUpsert.length} ECNs en base de datos...`,
                current: 0,
                total: finalEcnsToUpsert.length
            });

            await api.upsertEcns(finalEcnsToUpsert, fileName!, (prog) => {
                const mappedPercent = Math.min(100, Math.round(40 + (prog.percent * 0.6)));
                setImportProgress({
                    percent: mappedPercent,
                    stage: prog.stage,
                    current: prog.current,
                    total: prog.total,
                    newCount: prog.newCount,
                    updatedCount: prog.updatedCount
                });
            });

            setNotification({ message: `Importación completa. Se actualizaron ${finalEcnsToUpsert.length} ECNs con cambios detectados.`, type: 'success' });
            onImport();
            handleCancel();

        } catch (err) {
            setNotification({ message: (err as Error).message, type: 'error' });
        } finally {
            setIsLoading(false);
            setImportProgress(null);
        }
    };

    if (step === 'select') {
        return (
            <Card>
                <h2 className="text-xl font-semibold text-gray-800">1. Importar Reporte SAP (Principal)</h2>
                <p className="text-sm text-gray-600 my-2">Cree nuevos ECNs o actualice los existentes con nuevos datos de componentes desde el reporte de SAP.</p>

                <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-md">
                    <label className="flex items-center space-x-3 cursor-pointer">
                        <input
                            type="checkbox"
                            className="h-5 w-5 text-brand-red rounded border-gray-300 focus:ring-brand-red"
                            checked={isOtherSite}
                            onChange={(e) => setIsOtherSite(e.target.checked)}
                        />
                        <span className="text-sm font-medium text-blue-800">
                            ¿El archivo es de un sitio diferente a 5201? (Se asignará Familia VESDA)
                        </span>
                    </label>
                </div>

                <div className="flex items-center space-x-4 mt-4">
                    <label htmlFor="sap-import" className="cursor-pointer bg-brand-red text-white hover:bg-opacity-90 px-4 py-2 rounded-md text-sm font-medium">
                        {isLoading ? 'Procesando...' : 'Seleccionar Archivo Excel'}
                    </label>
                    <input id="sap-import" type="file" className="hidden" accept=".xlsx, .xls" onChange={handleFileChange} disabled={isLoading} />
                </div>

                <ImportProgressModal
                    isOpen={isLoading && importProgress !== null}
                    percent={importProgress?.percent || 0}
                    stage={importProgress?.stage}
                    current={importProgress?.current}
                    total={importProgress?.total}
                    newCount={importProgress?.newCount}
                    updatedCount={importProgress?.updatedCount}
                    title="Importando Reporte SAP"
                />
            </Card>
        );
    }

    return (
        <Card>
            <h2 className="text-xl font-semibold text-gray-800">1. Importar Reporte SAP (Principal)</h2>
            <p className="text-sm text-gray-600 my-2">Cree nuevos ECNs o actualice los existentes con nuevos datos de componentes desde el reporte de SAP.</p>
            <div className="flex items-center space-x-4 mt-4 bg-gray-100 p-2 rounded-md">
                <Button onClick={handleCancel}>Cambiar archivo</Button>
                <span className="font-medium text-gray-700">{fileName}</span>
            </div>

            <div className="mt-6">
                <h3 className="text-lg font-semibold text-gray-800">Mapeo de Columnas</h3>
                <p className="text-sm text-gray-600 mb-4">Asigne las columnas de su archivo Excel a los campos de la base de datos.</p>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4">
                    {Object.entries(MAPPABLE_FIELDS).map(([key, field]) => (
                        <div key={key}>
                            <label className="block text-sm font-medium text-gray-700">
                                {field.label} {field.required && <span className="text-red-500">*</span>}
                            </label>
                            <select
                                value={mappings[key] || ''}
                                onChange={(e) => handleMappingChange(key, e.target.value)}
                                className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-brand-red focus:border-brand-red sm:text-sm rounded-md bg-white text-gray-900"
                            >
                                <option value="">-- No seleccionado --</option>
                                {headers.map((header, index) => (
                                    <option key={`${header}-${index}`} value={header}>{header}</option>
                                ))}
                            </select>
                        </div>
                    ))}
                </div>
            </div>

            <div className="mt-6 flex justify-end space-x-2">
                <Button variant="secondary" onClick={handleCancel} disabled={isLoading}>
                    Cancelar
                </Button>
                <Button variant="primary" onClick={handleProcessImport} disabled={isLoading || !mappings.ecn}>
                    {isLoading ? 'Procesando...' : 'Procesar e Importar'}
                </Button>
            </div>

            {showSiteModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 z-[100] flex justify-center items-center p-4">
                    <Card className="max-w-md w-full">
                        <h3 className="text-lg font-semibold text-gray-800 mb-4">Seleccionar Sitio</h3>
                        <p className="text-sm text-gray-600 mb-4">
                            Ha indicado que este reporte pertenece a un sitio diferente a 5201. Por favor, seleccione el sitio correspondiente:
                        </p>
                        <select
                            value={selectedSite}
                            onChange={(e) => setSelectedSite(e.target.value)}
                            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-red bg-white text-gray-900 mb-6"
                        >
                            <option value="5205">5205</option>
                            <option value="5382">5382</option>
                            <option value="4438">4438</option>
                            <option value="5731">5731</option>
                        </select>
                        <div className="flex justify-end space-x-2">
                            <Button variant="secondary" onClick={() => setShowSiteModal(false)}>Cancelar</Button>
                            <Button variant="primary" onClick={handleProcessImport}>Confirmar y Procesar</Button>
                        </div>
                    </Card>
                </div>
            )}

            <ImportProgressModal
                isOpen={isLoading && importProgress !== null}
                percent={importProgress?.percent || 0}
                stage={importProgress?.stage}
                current={importProgress?.current}
                total={importProgress?.total}
                newCount={importProgress?.newCount}
                updatedCount={importProgress?.updatedCount}
                title="Importando Reporte SAP"
            />
        </Card>
    );
};

// --- Importer for Descriptions ---
const DescriptionImporter: React.FC<{ onImport: () => void, setNotification: (n: any) => void }> = ({ onImport, setNotification }) => {
    const [isLoading, setIsLoading] = useState(false);
    const [isSapWebGuiModalOpen, setIsSapWebGuiModalOpen] = useState(false);

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setIsLoading(true);
        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const json = XLSX.utils.sheet_to_json(worksheet) as any[];

            if (json.length === 0) throw new Error("El archivo está vacío.");

            const headers = Object.keys(json[0]).map(h => h.trim().toLowerCase());
            if (!headers.includes('ecn') || !headers.includes('description')) {
                throw new Error("El archivo debe tener las columnas 'ECN' y 'Description'.");
            }

            const dataToImport = json.map(row => ({
                ECN: String(row.ECN || row.ecn),
                Description: String(row.Description || row.description)
            })).filter(r => r.ECN);

            await api.importDescriptions(dataToImport, file.name);
            setNotification({ message: `${dataToImport.length} descripciones de ECNs actualizadas.`, type: 'success' });
            onImport();
        } catch (err) {
            setNotification({ message: (err as Error).message, type: 'error' });
        } finally {
            setIsLoading(false);
            event.target.value = '';
        }
    };

    const handleDownloadTemplate = () => {
        const data = [{ ECN: '2023-1234', Description: 'Nueva descripción para este ECN' }];
        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Descripciones');
        worksheet['!cols'] = [{ wch: 15 }, { wch: 50 }];
        XLSX.writeFile(workbook, 'plantilla_descripciones.xlsx');
    };

    return (
        <Card>
            <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="text-xl font-semibold text-gray-800">Importar / Actualizar Descripciones de ECNs</h2>
                <span className="text-xs bg-blue-100 text-blue-800 font-semibold px-2.5 py-1 rounded-full">
                    Soporta SAP WebGUI & Excel
                </span>
            </div>
            <p className="text-sm text-gray-600 my-2">
                Actualice masivamente las descripciones de los ECNs existentes usando un archivo Excel o directamente consultando y sincronizando con <strong>SAP WebGUI</strong> (CC03 / IQS3 / ZPP_CC07).
            </p>
            <div className="flex items-center flex-wrap gap-3 mt-4">
                <label htmlFor="desc-import" className="cursor-pointer bg-gray-200 text-gray-800 hover:bg-gray-300 px-4 py-2 rounded-md text-sm font-medium">
                    {isLoading ? 'Procesando Excel...' : 'Seleccionar Archivo Excel'}
                </label>
                <input id="desc-import" type="file" className="hidden" accept=".xlsx, .xls" onChange={handleFileChange} disabled={isLoading} />
                <Button variant="secondary" onClick={handleDownloadTemplate} disabled={isLoading}>Descargar Plantilla</Button>
                <Button
                    variant="primary"
                    onClick={() => setIsSapWebGuiModalOpen(true)}
                    disabled={isLoading}
                    className="bg-blue-600 hover:bg-blue-700 text-white flex items-center space-x-2"
                >
                    <span>🚀 Transacción IQS3 (I1S3): Extraer Descripciones de ECNs</span>
                </Button>
            </div>

            <SapDescriptionsSyncModal
                isOpen={isSapWebGuiModalOpen}
                onClose={() => setIsSapWebGuiModalOpen(false)}
                onUpdated={onImport}
                setNotification={setNotification}
            />
        </Card>
    );
};


// --- Importer for SKU/Family ---
const SkuFamilyImporter: React.FC<{ onImport: () => void, setNotification: (n: any) => void }> = ({ onImport, setNotification }) => {
    const [isLoading, setIsLoading] = useState(false);

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setIsLoading(true);
        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const json = XLSX.utils.sheet_to_json(worksheet) as any[];

            if (json.length === 0) throw new Error("El archivo está vacío.");

            const headers = Object.keys(json[0]).map(h => h.trim().toLowerCase());
            if (!headers.includes('assembly') || !headers.includes('sku') || !headers.includes('family')) {
                throw new Error("El archivo debe tener las columnas 'Assembly', 'SKU' y 'Family'.");
            }

            const dataToImport = json.map(row => ({
                Assembly: String(row.Assembly || row.assembly).trim(),
                SKU: String(row.SKU || row.sku).trim(),
                Family: String(row.Family || row.family).trim()
            })).filter(r => r.Assembly);

            await api.importSkuFamily(dataToImport, file.name);
            setNotification({ message: `Datos de SKU/Familia actualizados para ${dataToImport.length} ensambles.`, type: 'success' });
            onImport();

        } catch (err) {
            setNotification({ message: (err as Error).message, type: 'error' });
        } finally {
            setIsLoading(false);
            event.target.value = '';
        }
    };

    const handleDownloadTemplate = () => {
        const data = [{ Assembly: '123-ABC', SKU: 'SKU001', Family: 'Product Family X' }];
        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'SKU_Familia');
        worksheet['!cols'] = [{ wch: 20 }, { wch: 20 }, { wch: 25 }];
        XLSX.writeFile(workbook, 'plantilla_sku_familia.xlsx');
    };

    return (
        <Card>
            <h2 className="text-xl font-semibold text-gray-800">Importar SKU y Familia por Ensamble</h2>
            <p className="text-sm text-gray-600 my-2">Asigne SKU y Familia a los ensambles de los cambios de componentes. El archivo debe contener 'Assembly', 'SKU' y 'Family'.</p>
            <div className="flex items-center space-x-4 mt-4">
                <label htmlFor="sku-import" className="cursor-pointer bg-gray-200 text-gray-800 hover:bg-gray-300 px-4 py-2 rounded-md text-sm font-medium">
                    {isLoading ? 'Procesando...' : 'Seleccionar Archivo'}
                </label>
                <input id="sku-import" type="file" className="hidden" accept=".xlsx, .xls" onChange={handleFileChange} disabled={isLoading} />
                <Button variant="secondary" onClick={handleDownloadTemplate}>Descargar Plantilla</Button>
            </div>
        </Card>
    );
};

// --- Audit Trail Viewer ---
const AuditTrail: React.FC = () => {
    const [logs, setLogs] = useState<AuditLog[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const navigate = useNavigate();

    const fetchLogs = useCallback(async () => {
        setIsLoading(true);
        try {
            const logData = await api.getAuditLogs();
            setLogs(logData);
        } catch (error) {
            console.error("Failed to fetch audit logs", error);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchLogs();
    }, [fetchLogs]);

    const getTypeClass = (type: string) => {
        switch (type) {
            case 'Importación':
                return 'bg-blue-100 text-blue-800';
            case 'Modificación':
                return 'bg-green-100 text-green-800';
            default:
                return 'bg-gray-100 text-gray-800';
        }
    };

    // Helper to render text with ECN numbers parsed as clickable hyperlinks
    const renderTargetCell = (target: string) => {
        if (!target) return <span className="text-gray-400">—</span>;

        // If target is directly an ECN identifier (e.g., ECN-12345, 100012345, or purely numeric/alphanumeric code)
        const trimmed = target.trim();
        // Check if the whole target is an ECN or starts with ECN
        const isSingleEcn = /^(ECN[-\s]?\d+|\d{5,12}|[A-Z0-9]{6,15})$/i.test(trimmed) &&
            !['usuarios', 'descripciones ecn', 'sku/familia', 'sistema'].includes(trimmed.toLowerCase()) &&
            !trimmed.toLowerCase().endsWith('.xlsx') && !trimmed.toLowerCase().endsWith('.xls') && !trimmed.toLowerCase().endsWith('.csv');

        if (isSingleEcn) {
            return (
                <Link
                    to={`/edit/${encodeURIComponent(trimmed)}`}
                    className="text-blue-600 hover:text-blue-800 hover:underline font-semibold flex items-center gap-1 inline-flex"
                    title={`Hacer clic para editar ECN ${trimmed}`}
                >
                    <span>{trimmed}</span>
                    <span className="text-xs">↗</span>
                </Link>
            );
        }

        return <span>{target}</span>;
    };

    // Helper to parse any ECN numbers inside details text or target text
    const renderDetailsCell = (details: string) => {
        if (!details) return <span className="text-gray-400">—</span>;

        // Regex to identify ECN tokens like ECN 123456, ECN-123456, or explicit numeric ECN patterns
        const ecnRegex = /\b(ECN[-\s]?\d{4,12}|\b\d{7,10}\b)/gi;
        const parts: (string | React.ReactNode)[] = [];
        let lastIndex = 0;
        let match;

        while ((match = ecnRegex.exec(details)) !== null) {
            if (match.index > lastIndex) {
                parts.push(details.substring(lastIndex, match.index));
            }
            const rawToken = match[0];
            const cleanId = rawToken.replace(/^ECN[-\s]?/i, '').trim();
            const targetId = rawToken.toUpperCase().startsWith('ECN') ? rawToken : (cleanId || rawToken);

            parts.push(
                <Link
                    key={`${match.index}-${rawToken}`}
                    to={`/edit/${encodeURIComponent(targetId)}`}
                    className="text-blue-600 hover:text-blue-800 hover:underline font-medium inline-flex items-center mx-0.5"
                    title={`Editar ECN ${targetId}`}
                >
                    {rawToken}
                </Link>
            );
            lastIndex = ecnRegex.lastIndex;
        }

        if (lastIndex < details.length) {
            parts.push(details.substring(lastIndex));
        }

        return <>{parts.length > 0 ? parts : details}</>;
    };

    return (
        <Card>
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-semibold text-gray-800">Historial y Auditoría</h2>
                <span className="text-xs text-gray-500">Haga clic en los números de ECN para editarlos directamente</span>
            </div>
            <div className="overflow-y-auto h-96 border rounded-md">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50 sticky top-0">
                        <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Fecha</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Usuario</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tipo</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Objetivo</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Detalles</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {isLoading ? (
                            <tr><td colSpan={5} className="text-center py-4">Cargando historial...</td></tr>
                        ) : logs.length > 0 ? (
                            logs.map(log => (
                                <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500">{new Date(log.timestamp).toLocaleString()}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm font-medium text-gray-900">{log.user}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm">
                                        <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getTypeClass(log.type)}`}>{log.type}</span>
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-700">
                                        {renderTargetCell(log.target)}
                                    </td>
                                    <td className="px-4 py-2 text-sm text-gray-600">
                                        {renderDetailsCell(log.details)}
                                    </td>
                                </tr>
                            ))
                        ) : (
                            <tr><td colSpan={5} className="text-center py-4">No hay registros de auditoría.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </Card>
    );
};


// --- Importer for Automated Multi-Sheet VBA Consolidation ---
const AutomatedVbaImporter: React.FC<{ onImport: () => void, setNotification: (n: { message: string, type: 'success' | 'error' } | null) => void }> = ({ onImport, setNotification }) => {
    const [isLoading, setIsLoading] = useState(false);
    const [importProgress, setImportProgress] = useState<{
        percent: number;
        stage: string;
        current?: number;
        total?: number;
        newCount?: number;
        updatedCount?: number;
    } | null>(null);

    const parseDate = (dateInput: any): string | null => {
        if (!dateInput) return null;
        if (dateInput instanceof Date && !isNaN(dateInput.getTime())) {
            const year = dateInput.getFullYear();
            const month = dateInput.getMonth();
            const day = dateInput.getDate();
            return new Date(Date.UTC(year, month, day)).toISOString().split('T')[0];
        }
        if (typeof dateInput === 'number' && dateInput > 1) {
            const excelEpoch = new Date(Date.UTC(1899, 11, 30));
            const date = new Date(excelEpoch.getTime() + dateInput * 24 * 60 * 60 * 1000);
            if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
        }
        if (typeof dateInput === 'string') {
            const trimmedDate = dateInput.trim().split('T')[0].split(' ')[0];
            // YYYY-MM-DD
            let parts = trimmedDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
            if (parts) return `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`;
            // M/D/YYYY or MM/DD/YYYY
            parts = trimmedDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
            if (parts) return `${parts[3]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
            // DD.MM.YYYY (SAP format)
            parts = trimmedDate.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
            if (parts) return `${parts[3]}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
        }
        return null;
    };

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setIsLoading(true);
        setNotification(null);
        setImportProgress({
            percent: 5,
            stage: 'Leyendo archivo Excel Multi-Hoja...',
            current: 0,
            total: 0
        });
        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data, { cellDates: true });

            setImportProgress({
                percent: 15,
                stage: 'Extrayendo tablas de datos, SKUs y Descripciones...',
                current: 0,
                total: 0
            });

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
                // Multi-sheet consolidation logic (replicating VBA Macro)
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
                        if (assy && (sku || fam)) {
                            skuMap.set(assy, { sku, family: fam });
                        }
                        const ecnVal = String(r.ECRO || r.ECN || r.ecn || '').trim();
                        const descVal = String(r.Description || r.description || r.Descripción || '').trim();
                        if (ecnVal && descVal) {
                            descMap.set(ecnVal, descVal);
                        }
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

            if (consolidatedRows.length === 0) {
                throw new Error("No se encontraron registros de datos en el archivo.");
            }

            setImportProgress({
                percent: 25,
                stage: 'Consultando ECNs existentes en la base de datos...',
                current: 0,
                total: consolidatedRows.length
            });

            const existingEcns = await api.getEcns({ timeFilter: 'Todos' });
            const existingEcnsMap = new Map(existingEcns.map(e => [e.id, e]));
            const ecnsToUpsertMap = new Map<string, ECN>();
            const todayStr = new Date().toISOString().split('T')[0];

            let skippedPlant5201Count = 0;

            consolidatedRows.forEach(row => {
                const plantHeaderKey = Object.keys(row).find(k => k.toLowerCase().includes('plant') || k.toLowerCase().includes('planta'));
                if (plantHeaderKey && row[plantHeaderKey] !== undefined && row[plantHeaderKey] !== null) {
                    const pVal = String(row[plantHeaderKey]).trim();
                    if (pVal === '5201') {
                        skippedPlant5201Count++;
                        return; // Ignore Plant 5201
                    }
                }

                const ecnId = String(row.ECNO || row.ECN || row.ecn || row['Change No.'] || row['change no.'] || '').trim();
                if (!ecnId) return;

                const assembly = String(row.Assembly || row.assembly || '').trim();
                const oldComponent = String(row.Component || row.component || row.OldComponent || '').trim();
                const newComponent = String(row['Start Material'] || row.newComponent || row.material || '').trim();

                let ecn = ecnsToUpsertMap.get(ecnId);
                let isNewEcn = false;
                if (!ecn) {
                    const existing = existingEcnsMap.get(ecnId);
                    if (existing) {
                        ecn = JSON.parse(JSON.stringify(existing));
                    } else {
                        isNewEcn = true;
                        ecn = {
                            id: ecnId,
                            initiator: String(row['Created by'] || row.createdBy || row.initiator || 'Sistema'),
                            description: String(row.Description || row.description || row.AssemblyDescription || `ECN importado ${ecnId}`),
                            status: ECNStatus.Pending,
                            creationDate: parseDate(row['Created On'] || row.createdOn) || todayStr,
                            implementationDate: '',
                            daysRemaining: 0,
                            changes: [], notes: [], auditLog: [], checklist: []
                        };
                    }
                }
                if (!ecn) return;

                const noteText = String(row.Notes || row.notes || row.Notas || '').trim();
                let noteAdded = false;
                if (noteText) {
                    if (!ecn.notes) ecn.notes = [];
                    if (!ecn.notes.some(n => n.text === noteText)) {
                        ecn.notes.push({
                            id: `note-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
                            author: String(row['Created by'] || row.createdBy || 'Sistema'),
                            text: noteText,
                            date: todayStr
                        });
                        noteAdded = true;
                    }
                }

                const startDate = parseDate(row['Start date'] || row.startDate || row['Valid From']);
                if (!startDate) return;

                const newDemand = Number(row.Demand || row.demand) || 0;
                const newOnHand = Number(row['On hand inventory'] || row.onHandInventory) || 0;
                const newOpenPo = Number(row['Open PO Qty'] || row.openPoQty) || 0;
                const skuVal = String(row.SKU || row.sku || '').trim() || undefined;
                const familyVal = String(row.Family || row.family || row.Familia || '').trim() || undefined;
                const siteVal = plantHeaderKey && row[plantHeaderKey] ? String(row[plantHeaderKey]).trim() : '5205';

                const newChangeValues: ComponentChange = {
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

                const existingChangeIndex = ecn.changes.findIndex(c =>
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
                        if (isDateChanged && newDate > todayStr) {
                            ecn.status = ECNStatus.Pending;
                        }
                        existingChange.startDate = newChangeValues.startDate;
                        existingChange.demand = newDemand;
                        existingChange.onHandInventory = newOnHand;
                        existingChange.openPoQty = newOpenPo;
                        if (familyVal !== undefined) existingChange.family = familyVal;
                        if (skuVal !== undefined) existingChange.sku = skuVal;
                        if (newChangeValues.assemblyDescription) existingChange.assemblyDescription = newChangeValues.assemblyDescription;
                        if (newChangeValues.newComponentDescription) existingChange.newComponentDescription = newChangeValues.newComponentDescription;
                        if (newChangeValues.newComponentRevision) existingChange.newComponentRevision = newChangeValues.newComponentRevision;
                        if (newChangeValues.assemblyRevision) existingChange.assemblyRevision = newChangeValues.assemblyRevision;
                        componentChanged = true;
                    }
                } else {
                    const newDate = newChangeValues.startDate.split('T')[0];
                    if (newDate > todayStr) {
                        ecn.status = ECNStatus.Pending;
                    }
                    ecn.changes.push(newChangeValues);
                    componentChanged = true;
                }

                if (isNewEcn || componentChanged || noteAdded) {
                    ecnsToUpsertMap.set(ecnId, ecn);
                }
            });

            const finalEcnsToUpsert = Array.from(ecnsToUpsertMap.values());
            if (finalEcnsToUpsert.length === 0) {
                setNotification({ message: 'El archivo no contiene cambios nuevos respecto a la base de datos.', type: 'success' });
                setIsLoading(false);
                setImportProgress(null);
                return;
            }

            const todayDate = new Date();
            todayDate.setUTCHours(0, 0, 0, 0);

            finalEcnsToUpsert.forEach(ecn => {
                if (ecn.status === ECNStatus.Canceled) return;
                if (ecn.changes.length > 0) {
                    let allDatesArePastOrPresent = true;
                    let allDatesAreFuture = true;
                    let latestDate = new Date(0);
                    let hasAtLeastOneValidDate = false;

                    for (const change of ecn.changes) {
                        if (!change.startDate) {
                            allDatesArePastOrPresent = false;
                            continue;
                        }
                        hasAtLeastOneValidDate = true;
                        const changeDate = new Date(change.startDate);
                        const changeDateUTC = new Date(Date.UTC(changeDate.getUTCFullYear(), changeDate.getUTCMonth(), changeDate.getUTCDate()));
                        if (changeDateUTC > todayDate) {
                            allDatesArePastOrPresent = false;
                        } else {
                            allDatesAreFuture = false;
                        }
                        if (changeDateUTC > latestDate) latestDate = changeDateUTC;
                    }

                    ecn.implementationDate = hasAtLeastOneValidDate ? latestDate.toISOString().split('T')[0] : '';
                    if (hasAtLeastOneValidDate) {
                        if (allDatesArePastOrPresent) {
                            ecn.status = ECNStatus.Implemented;
                        } else if (allDatesAreFuture) {
                            ecn.status = ECNStatus.Pending;
                        } else {
                            ecn.status = ECNStatus.PartialImplemented;
                        }
                    } else {
                        ecn.status = ECNStatus.Pending;
                    }
                }
            });

            setImportProgress({
                percent: 35,
                stage: `Guardando ${finalEcnsToUpsert.length} ECNs consolidados en base de datos...`,
                current: 0,
                total: finalEcnsToUpsert.length
            });

            await api.upsertEcns(finalEcnsToUpsert, file.name, (prog: any) => {
                const mappedPercent = Math.min(100, Math.round(35 + (prog.percent * 0.65)));
                setImportProgress({
                    percent: mappedPercent,
                    stage: prog.stage,
                    current: prog.current,
                    total: prog.total,
                    newCount: prog.newCount,
                    updatedCount: prog.updatedCount
                });
            });

            setNotification({
                message: `Consolidación automatizada completada. ${finalEcnsToUpsert.length} ECNs procesados. Registros ignorados de Planta 5201: ${skippedPlant5201Count}.`,
                type: 'success'
            });
            onImport();

        } catch (err) {
            setNotification({ message: (err as Error).message, type: 'error' });
        } finally {
            setIsLoading(false);
            setImportProgress(null);
            event.target.value = '';
        }
    };

    return (
        <Card className="border-2 border-brand-red/30 bg-gradient-to-r from-red-50/50 to-amber-50/50">
            <div className="flex items-start justify-between">
                <div>
                    <div className="flex items-center space-x-2">
                        <span className="px-2 py-0.5 text-xs font-bold bg-brand-red text-white rounded">NUEVO</span>
                        <h2 className="text-xl font-semibold text-gray-800">Importador Automatizado Multi-Hoja (Consolidación VBA)</h2>
                    </div>
                    <p className="text-sm text-gray-600 my-2">
                        Procesa automáticamente libros Excel consolidados o multi-hoja (ej. <code className="bg-gray-200 px-1 py-0.5 rounded text-xs">SAP DATA ECN</code>, <code className="bg-gray-200 px-1 py-0.5 rounded text-xs">Description_SKU_Family</code> o <code className="bg-gray-200 px-1 py-0.5 rounded text-xs">Output</code>). Consolida en memoria SKUs, Familias y Descripciones por ensamble y aplica la exclusión automática de Planta 5201.
                    </p>
                </div>
            </div>

            <div className="flex items-center space-x-4 mt-4">
                <label htmlFor="auto-vba-import" className="cursor-pointer bg-brand-red text-white hover:bg-opacity-90 px-4 py-2 rounded-md text-sm font-medium transition-colors shadow">
                    {isLoading ? 'Procesando y Consolidando...' : 'Seleccionar Libro Excel Consolidado'}
                </label>
                <input id="auto-vba-import" type="file" className="hidden" accept=".xlsx, .xls" onChange={handleFileChange} disabled={isLoading} />
            </div>

            <ImportProgressModal
                isOpen={isLoading && importProgress !== null}
                percent={importProgress?.percent || 0}
                stage={importProgress?.stage}
                current={importProgress?.current}
                total={importProgress?.total}
                newCount={importProgress?.newCount}
                updatedCount={importProgress?.updatedCount}
                title="Importador Automatizado Multi-Hoja"
            />
        </Card>
    );
};


// --- Direct Automated SAP Synchronization Component (No file upload required) ---
// Field labels for the preview table (matches MAPPABLE_FIELDS keys that the backend uses)
const SAP_PREVIEW_FIELD_LABELS: { key: string; label: string; width?: string }[] = [
    { key: 'ecnNumber', label: 'ECN #', width: '110px' },
    { key: 'assembly', label: 'Assembly', width: '130px' },
    { key: 'oldComponent', label: 'Comp. Anterior', width: '130px' },
    { key: 'newComponent', label: 'Comp. Nuevo', width: '130px' },
    { key: 'assemblyDescription', label: 'Desc. Ensamble', width: '180px' },
    { key: 'assemblyRevision', label: 'Rev.', width: '60px' },
    { key: 'startDate', label: 'Fecha Inicio', width: '110px' },
    { key: 'plant', label: 'Planta', width: '70px' },
    { key: 'demand', label: 'Demand', width: '80px' },
    { key: 'onHandInventory', label: 'On Hand', width: '80px' },
    { key: 'openPoQty', label: 'Open PO', width: '80px' },
    { key: 'initiator', label: 'Creado Por', width: '110px' },
    { key: 'creationDate', label: 'Fecha Creación', width: '110px' },
    { key: 'sku', label: 'SKU', width: '110px' },
    { key: 'family', label: 'Familia', width: '80px' },
    { key: 'comments', label: 'Notas', width: '160px' },
];

const DirectAutomatedSync: React.FC<{ onImport: () => void, setNotification: (n: { message: string, type: 'success' | 'error' } | null) => void }> = ({ onImport, setNotification }) => {
    const [step, setStep] = useState<'select' | 'map'>('select');
    const [isLoading, setIsLoading] = useState(false);
    const [isUpdatingDescriptions, setIsUpdatingDescriptions] = useState(false);
    const [showSapDescModal, setShowSapDescModal] = useState(false);
    const today = new Date().toISOString().split('T')[0];
    const oneYearAgo = new Date(new Date().setFullYear(new Date().getFullYear() - 1)).toISOString().split('T')[0];
    const [startDate, setStartDate] = useState(oneYearAgo);
    const [endDate, setEndDate] = useState(today);
    const [plant, setPlant] = useState('5205');
    const [mxohEnabled, setMxohEnabled] = useState(false);
    const [mxohInput, setMxohInput] = useState('');
    const [showMxohConfig, setShowMxohConfig] = useState(false);
    const [isSavingMxoh, setIsSavingMxoh] = useState(false);
    const [showSapSessionModal, setShowSapSessionModal] = useState(false);
    const [sapSessionLogs, setSapSessionLogs] = useState<string[]>([]);
    const [sapSystemInput, setSapSystemInput] = useState('');
    const [sapSystemLoading, setSapSystemLoading] = useState(false);

    // Dynamic mapping & preview states (matching SapReportImporter)
    const [headers, setHeaders] = useState<string[]>([]);
    const [jsonData, setJsonData] = useState<any[]>([]);
    const [mappings, setMappings] = useState<Record<string, string>>({});
    const [fileName, setFileName] = useState<string | null>(null);
    const [isOtherSite, setIsOtherSite] = useState(false);
    const [selectedSite, setSelectedSite] = useState<string>('5205');
    const [showSiteModal, setShowSiteModal] = useState(false);
    const [previewFilter, setPreviewFilter] = useState('');
    const [importProgress, setImportProgress] = useState<{
        percent: number;
        stage: string;
        current?: number;
        total?: number;
        newCount?: number;
        updatedCount?: number;
    } | null>(null);

    useEffect(() => {
        api.getSetting('mxoh_plant_5201_enabled').then(val => {
            const enabled = val === 'true' || val === '1';
            setMxohEnabled(enabled);
            setMxohInput(val || '');
        });
    }, []);

    const handleSaveMxoh = async () => {
        setIsSavingMxoh(true);
        try {
            await api.saveSetting('mxoh_plant_5201_enabled', mxohInput.trim());
            const enabled = mxohInput.trim() === 'true' || mxohInput.trim() === '1';
            setMxohEnabled(enabled);
            setNotification({ message: `Configuración MXOH guardada. Planta 5201 ${enabled ? 'habilitada' : 'deshabilitada'}.`, type: 'success' });
            setShowMxohConfig(false);
            if (!enabled && plant === '5201') setPlant('5205');
        } catch (err: any) {
            setNotification({ message: `Error al guardar configuración: ${err.message}`, type: 'error' });
        } finally {
            setIsSavingMxoh(false);
        }
    };

    const parseDate = (dateInput: any): string | null => {
        if (!dateInput) return null;

        if (dateInput instanceof Date && !isNaN(dateInput.getTime())) {
            const year = dateInput.getFullYear();
            const month = dateInput.getMonth();
            const day = dateInput.getDate();
            const utcDate = new Date(Date.UTC(year, month, day));
            return utcDate.toISOString().split('T')[0];
        }

        if (typeof dateInput === 'number' && dateInput > 1) {
            const excelEpoch = new Date(Date.UTC(1899, 11, 30));
            const date = new Date(excelEpoch.getTime() + dateInput * 24 * 60 * 60 * 1000);
            if (!isNaN(date.getTime())) {
                return date.toISOString().split('T')[0];
            }
        }

        if (typeof dateInput === 'string') {
            const trimmedDate = dateInput.trim().split(' ')[0];
            let parts;
            let year, month, day;

            parts = trimmedDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
            if (parts) {
                year = parseInt(parts[1], 10);
                month = parseInt(parts[2], 10) - 1;
                day = parseInt(parts[3], 10);
            } else {
                parts = trimmedDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                if (parts) {
                    year = parseInt(parts[3], 10);
                    month = parseInt(parts[1], 10) - 1;
                    day = parseInt(parts[2], 10);
                } else {
                    return null;
                }
            }

            if (year > 1900 && month >= 0 && month <= 11 && day >= 1 && day <= 31) {
                const utcDate = new Date(Date.UTC(year, month, day));
                if (utcDate.getUTCFullYear() === year && utcDate.getUTCMonth() === month && utcDate.getUTCDate() === day) {
                    return utcDate.toISOString().split('T')[0];
                }
            }
        }
        return null;
    };

    // STEP 1: Execute SAP Extraction and prepare Mapping & Preview
    const handleRunAutomatedExtraction = async () => {
        setIsLoading(true);
        setNotification(null);
        try {
            const res = await api.runVbaSyncPreview({ startDate, endDate, plant });
            const rawJsonData = res.jsonData || res.records || [];
            console.log(rawJsonData);
            if (rawJsonData.length === 0) {
                setNotification({ message: 'SAP no devolvió registros para el período y planta seleccionados.', type: 'error' });
                return;
            }

            // Extract or normalize headers
            let parsedHeaders: string[] = res.headers && res.headers.length > 0 ? res.headers : Object.keys(rawJsonData[0] || {});

            // Auto-mapping logic using MAPPABLE_FIELDS aliases
            const initialMappings: Record<string, string> = {};
            for (const key in MAPPABLE_FIELDS) {
                const field = MAPPABLE_FIELDS[key];
                const allAliases = [field.label.toLowerCase(), ...(field.aliases || [])];

                const foundHeader = parsedHeaders.find(h => {
                    const originalHeader = h.replace(/_\d+$/, '').toLowerCase().trim();
                    return allAliases.includes(originalHeader);
                });

                if (foundHeader) {
                    initialMappings[key] = foundHeader;
                }
            }

            setHeaders(parsedHeaders);
            setJsonData(rawJsonData);
            setMappings(initialMappings);
            setFileName(`SAP_ZPP_CC07_Planta_${plant}_${startDate}_a_${endDate}`);
            setStep('map');

        } catch (err: any) {
            console.error('SAP Preview Error:', err);
            if (err && err.status === 412) {
                setSapSessionLogs(err.logs || []);
                setShowSapSessionModal(true);
            }
            setNotification({
                message: err.message || 'Error al ejecutar la extracción de datos SAP.',
                type: 'error'
            });
        } finally {
            setIsLoading(false);
        }
    };

    const handleMappingChange = (fieldKey: string, selectedHeader: string) => {
        setMappings(prev => ({ ...prev, [fieldKey]: selectedHeader }));
    };

    const handleCancel = () => {
        setStep('select');
        setFileName(null);
        setHeaders([]);
        setJsonData([]);
        setMappings({});
        setIsOtherSite(false);
        setShowSiteModal(false);
        setPreviewFilter('');
    };

    // STEP 2: Process & Upsert using the exact same robust logic as SapReportImporter
    const handleProcessImport = async () => {
        if (isOtherSite && !showSiteModal) {
            setShowSiteModal(true);
            return;
        }
        setShowSiteModal(false);
        setIsLoading(true);
        setNotification(null);
        setImportProgress({
            percent: 5,
            stage: 'Consultando ECNs existentes en la base de datos...',
            current: 0,
            total: jsonData.length
        });
        try {
            const existingEcns = await api.getEcns({ timeFilter: 'Todos' });

            let vesdaMaterials: any[] = [];
            if (isOtherSite) {
                setImportProgress({
                    percent: 15,
                    stage: 'Consultando catálogo de materiales VESDA...',
                    current: 0,
                    total: jsonData.length
                });
                vesdaMaterials = await api.getMatVesda();
            }

            setImportProgress({
                percent: 25,
                stage: 'Analizando y estructurando cambios de componentes...',
                current: 0,
                total: jsonData.length
            });

            const existingEcnsMap = new Map(existingEcns.map(e => [e.id, e]));
            const ecnsToUpsertMap = new Map<string, ECN>();
            const todayStr = new Date().toISOString().split('T')[0];
            const currentSite = isOtherSite ? selectedSite : plant;

            // Track field-level changes per ECN for detailed audit
            const auditDetails: { ecnId: string; action: 'NUEVO' | 'ACTUALIZADO'; fields: string[] }[] = [];

            jsonData.forEach(row => {
                // Strict filter: Ignore any record where Plant is 5201 unless MXOH is enabled
                if (!mxohEnabled && mappings.plant && row[mappings.plant] !== undefined && row[mappings.plant] !== null) {
                    const plantVal = String(row[mappings.plant]).trim();
                    if (plantVal === '5201') {
                        return; // Skip record
                    }
                }

                const ecnId = String(row[mappings.ecn] || '').trim();
                if (!ecnId) return;

                const assembly = String(row[mappings.assembly] || '').trim();
                const oldComponent = String(row[mappings.oldComponent] || '').trim();
                const newComponent = String(row[mappings.newComponent] || '').trim();

                if (isOtherSite) {
                    const isAllowed = vesdaMaterials.some(m =>
                        (m.material && m.material.trim() === assembly) ||
                        (m.material && m.material.trim() === oldComponent) ||
                        (m.material && m.material.trim() === newComponent)
                    );
                    if (!isAllowed) return;
                }

                let rowSite = currentSite;
                if (mappings.plant && row[mappings.plant]) {
                    const pVal = String(row[mappings.plant]).trim();
                    if (pVal) rowSite = pVal;
                }

                let ecn = ecnsToUpsertMap.get(ecnId);
                let isNewEcn = false;
                if (!ecn) {
                    const existing = existingEcnsMap.get(ecnId);
                    if (existing) {
                        ecn = JSON.parse(JSON.stringify(existing));
                    } else {
                        isNewEcn = true;
                        ecn = {
                            id: ecnId,
                            initiator: String(row[mappings.createdBy] || 'Sistema'),
                            description: String(row[mappings.assemblyDescription] || `ECN sincronizado ${ecnId}`),
                            status: ECNStatus.Pending,
                            creationDate: parseDate(row[mappings.createdOn]) || todayStr,
                            implementationDate: '',
                            daysRemaining: 0,
                            changes: [], notes: [], auditLog: [], checklist: []
                        };
                    }
                }

                if (!ecn) return;

                // Extract notes if present
                const noteText = mappings.notes && row[mappings.notes] ? String(row[mappings.notes]).trim() : '';
                let noteAdded = false;
                if (noteText) {
                    if (!ecn.notes) ecn.notes = [];
                    const alreadyHasNote = ecn.notes.some(n => n.text === noteText);
                    if (!alreadyHasNote) {
                        ecn.notes.push({
                            id: `note-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
                            author: String(row[mappings.createdBy] || 'Sistema'),
                            text: noteText,
                            date: todayStr
                        });
                        noteAdded = true;
                    }
                }

                const startDateVal = parseDate(row[mappings.startDate]);
                if (!startDateVal) return;

                const newDemand = Number(row[mappings.demand]) || 0;
                const newOnHand = Number(row[mappings.onHandInventory]) || 0;
                const newOpenPo = Number(row[mappings.openPoQty]) || 0;
                const skuVal = mappings.sku && row[mappings.sku] ? String(row[mappings.sku]).trim() : undefined;
                const familyVal = mappings.family && row[mappings.family] ? String(row[mappings.family]).trim() : (isOtherSite ? 'VESDA' : undefined);

                const newChangeValues: ComponentChange = {
                    id: ``,
                    assembly: String(row[mappings.assembly] || ''),
                    oldComponent: String(row[mappings.oldComponent] || ''),
                    newComponent: String(row[mappings.newComponent] || ''),
                    startDate: startDateVal,
                    demand: newDemand,
                    onHandInventory: newOnHand,
                    openPoQty: newOpenPo,
                    assemblyDescription: String(row[mappings.assemblyDescription] || ''),
                    newComponentDescription: String(row[mappings.startMaterialDescription] || ''),
                    newComponentRevision: String(row[mappings.startMaterialRevision] || ''),
                    assemblyRevision: String(row[mappings.assemblyRevision] || ''),
                    sku: skuVal,
                    family: familyVal,
                    site: rowSite
                };

                const existingChangeIndex = ecn.changes.findIndex(c =>
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
                        if (isDateChanged && newDate > todayStr) {
                            ecn.status = ECNStatus.Pending;
                        }

                        existingChange.startDate = newChangeValues.startDate;
                        existingChange.demand = newDemand;
                        existingChange.onHandInventory = newOnHand;
                        existingChange.openPoQty = newOpenPo;
                        if (familyVal !== undefined) existingChange.family = familyVal;
                        if (skuVal !== undefined) existingChange.sku = skuVal;
                        if (newChangeValues.assemblyDescription) existingChange.assemblyDescription = newChangeValues.assemblyDescription;
                        if (newChangeValues.newComponentDescription) existingChange.newComponentDescription = newChangeValues.newComponentDescription;
                        if (newChangeValues.newComponentRevision) existingChange.newComponentRevision = newChangeValues.newComponentRevision;
                        if (newChangeValues.assemblyRevision) existingChange.assemblyRevision = newChangeValues.assemblyRevision;

                        componentChanged = true;
                    }
                } else {
                    const newDate = newChangeValues.startDate.split('T')[0];
                    if (newDate > todayStr) {
                        ecn.status = ECNStatus.Pending;
                    }
                    ecn.changes.push(newChangeValues);
                    componentChanged = true;
                }

                if (isNewEcn || componentChanged || noteAdded) {
                    ecnsToUpsertMap.set(ecnId, ecn);
                    // Track for audit
                    const existing = auditDetails.find(a => a.ecnId === ecnId);
                    if (existing) {
                        if (componentChanged) existing.fields.push('startDate', 'componentes');
                        if (noteAdded) existing.fields.push('notas');
                    } else {
                        const fields: string[] = [];
                        if (isNewEcn) { /* new ECN, no fields needed */ }
                        else {
                            if (componentChanged) fields.push('startDate', 'componentes');
                            if (noteAdded) fields.push('notas');
                        }
                        auditDetails.push({ ecnId, action: isNewEcn ? 'NUEVO' : 'ACTUALIZADO', fields });
                    }
                }
            });

            const finalEcnsToUpsert = Array.from(ecnsToUpsertMap.values());

            if (finalEcnsToUpsert.length === 0) {
                setNotification({ message: 'No se detectaron cambios ni nuevos ECNs para sincronizar.', type: 'success' });
                handleCancel();
                return;
            }

            finalEcnsToUpsert.forEach(ecn => {
                const totalComp = ecn.changes.length;
                if (totalComp > 0) {
                    const implementedCount = ecn.changes.filter(c => {
                        if (!c.startDate) return false;
                        const compDate = c.startDate.split('T')[0];
                        return compDate <= todayStr;
                    }).length;

                    if (implementedCount === totalComp) {
                        ecn.status = ECNStatus.Implemented;
                    } else if (implementedCount > 0) {
                        ecn.status = ECNStatus.PartialImplemented;
                    } else {
                        ecn.status = ECNStatus.Pending;
                    }
                }
            });

            const upsertResult = await api.upsertEcns(finalEcnsToUpsert, fileName || 'SAP_Direct_Sync', (prog) => {
                const mappedPercent = Math.min(100, Math.round(30 + (prog.percent * 0.7)));
                setImportProgress({
                    percent: mappedPercent,
                    stage: prog.stage,
                    current: prog.current,
                    total: prog.total,
                    newCount: prog.newCount,
                    updatedCount: prog.updatedCount
                });
            });

            // Once the ECNs are persisted, refresh each description from SAP.
            let descriptionsUpdated = 0;
            const descriptionErrors: string[] = [];
            for (let index = 0; index < finalEcnsToUpsert.length; index++) {
                const ecnId = finalEcnsToUpsert[index].id;
                setImportProgress({
                    percent: Math.min(99, 70 + Math.round(((index + 1) / finalEcnsToUpsert.length) * 30)),
                    stage: `Actualizando descripción SAP del ECN ${ecnId} (${index + 1} de ${finalEcnsToUpsert.length})...`,
                    current: index + 1,
                    total: finalEcnsToUpsert.length
                });

                try {
                    const descriptionResult = await api.updateMissingSapDescriptions(ecnId);
                    if (descriptionResult.success && descriptionResult.updatedCount > 0) {
                        descriptionsUpdated++;
                    } else if (!descriptionResult.success) {
                        descriptionErrors.push(`${ecnId}: ${descriptionResult.error || 'respuesta sin éxito'}`);
                    }
                } catch (error: any) {
                    descriptionErrors.push(`${ecnId}: ${error.message || 'error al consultar SAP'}`);
                }
            }

            // Post detailed audit entries per ECN
            const newOnes = auditDetails.filter(a => a.action === 'NUEVO');
            const updatedOnes = auditDetails.filter(a => a.action === 'ACTUALIZADO');
            const auditLines: string[] = [];
            if (newOnes.length > 0) auditLines.push(`NUEVOS (${newOnes.length}): ${newOnes.map(a => a.ecnId).join(', ')}`);
            if (updatedOnes.length > 0) auditLines.push(`ACTUALIZADOS (${updatedOnes.length}): ${updatedOnes.map(a => `${a.ecnId}[${a.fields.filter((v, i, arr) => arr.indexOf(v) === i).join('+')}]`).join(', ')}`);
            auditLines.push(`DESCRIPCIONES SAP: ${descriptionsUpdated} actualizadas${descriptionErrors.length > 0 ? `, ${descriptionErrors.length} con error` : ''}`);
            if (auditLines.length > 0) {
                await api.saveSetting('last_import_audit', auditLines.join(' | '));
                await fetch('http://localhost:8080/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: 'last_import_audit', value: auditLines.join(' | ') })
                }).catch(() => { });
            }

            setNotification({
                message: `Sincronización e Importación SAP completa. Se procesaron ${finalEcnsToUpsert.length} ECNs y se actualizaron ${descriptionsUpdated} descripciones desde SAP${descriptionErrors.length > 0 ? ` (${descriptionErrors.length} con error)` : ''}.`,
                type: descriptionErrors.length > 0 ? 'error' : 'success'
            });
            onImport();
            handleCancel();

        } catch (err) {
            setNotification({ message: (err as Error).message, type: 'error' });
        } finally {
            setIsLoading(false);
            setImportProgress(null);
        }
    };

    // Dedicated Button for Step 5: Update missing descriptions in DB from SAP WebGUI (CC03/IQS3)
    const handleUpdateMissingDescriptions = () => {
        setShowSapDescModal(true);
    };

    const handleRetryFromModal = async () => {
        setShowSapSessionModal(false);
        if (sapSystemInput && sapSystemInput.trim()) {
            try {
                setSapSystemLoading(true);
                await api.saveSetting('sap_system_name', sapSystemInput.trim());
            } catch (e: any) {
                setNotification({ message: `No se pudo guardar el nombre del sistema: ${e.message}`, type: 'error' });
            } finally {
                setSapSystemLoading(false);
            }
        }
        setTimeout(() => { handleRunAutomatedExtraction(); }, 300);
    };

    useEffect(() => {
        if (showSapSessionModal) {
            setSapSystemLoading(true);
            api.getSetting('sap_system_name').then(val => {
                setSapSystemInput(val || '');
            }).catch(() => {
                setSapSystemInput('');
            }).finally(() => setSapSystemLoading(false));
        }
    }, [showSapSessionModal]);

    // Filtered preview rows
    const filteredRows = useMemo(() => {
        if (!jsonData || jsonData.length === 0) return [];
        if (!previewFilter.trim()) return jsonData.slice(0, 15);
        const q = previewFilter.trim().toLowerCase();
        return jsonData.filter(r =>
            Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q))
        ).slice(0, 15);
    }, [jsonData, previewFilter]);

    // ---- RENDER: Mapping & Preview Step ----
    if (step === 'map') {
        return (
            <Card className="border-2 border-blue-500/40 bg-gradient-to-r from-blue-50/50 to-sky-50/50 shadow-md">
                <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
                    <div>
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="px-2.5 py-1 text-xs font-bold bg-blue-600 text-white rounded-full uppercase tracking-wide">
                                VISTA PREVIA Y MAPEO DE COLUMNAS SAP
                            </span>
                            <h2 className="text-xl font-bold text-blue-900">
                                Mapeo de Columnas y Previsualización de Datos SAP
                            </h2>
                        </div>
                        <p className="text-sm text-gray-600 mt-1">
                            Se extrajeron <strong>{jsonData.length} registros</strong> de SAP ({fileName}). Asigne o confirme el mapeo de columnas antes de consolidar en la base de datos.
                        </p>
                    </div>
                    <div className="flex gap-2">
                        <Button variant="secondary" onClick={handleCancel} disabled={isLoading}>
                            ✕ Cancelar
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleProcessImport}
                            disabled={isLoading || !mappings.ecn}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2 rounded-lg font-semibold shadow"
                        >
                            {isLoading ? 'Procesando...' : '✅ Procesar e Importar a Base de Datos'}
                        </Button>
                    </div>
                </div>

                <div className="p-3 bg-blue-50/80 border border-blue-200 rounded-md mb-5">
                    <label className="flex items-center space-x-3 cursor-pointer">
                        <input
                            type="checkbox"
                            className="h-5 w-5 text-brand-red rounded border-gray-300 focus:ring-brand-red"
                            checked={isOtherSite}
                            onChange={(e) => setIsOtherSite(e.target.checked)}
                        />
                        <span className="text-sm font-medium text-blue-800">
                            ¿El reporte es de un sitio diferente a 5201? (Se asignará Familia VESDA)
                        </span>
                    </label>
                </div>

                <div className="mt-4 bg-white p-4 rounded-lg border border-gray-200">
                    <h3 className="text-md font-semibold text-gray-800 mb-1">Mapeo de Columnas</h3>
                    <p className="text-xs text-gray-500 mb-4">
                        Verifique que los campos requeridos estén asignados a las columnas correspondientes extraídas de SAP.
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-3">
                        {Object.entries(MAPPABLE_FIELDS).map(([key, field]) => (
                            <div key={key} className="bg-gray-50 p-2.5 rounded border border-gray-200">
                                <label className="block text-xs font-semibold text-gray-700 truncate" title={field.label}>
                                    {field.label} {field.required && <span className="text-red-500">*</span>}
                                </label>
                                <select
                                    value={mappings[key] || ''}
                                    onChange={(e) => handleMappingChange(key, e.target.value)}
                                    className="mt-1 block w-full px-2 py-1.5 text-xs border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded bg-white text-gray-900"
                                >
                                    <option value="">-- No seleccionado --</option>
                                    {headers.map((header, index) => (
                                        <option key={`${header}-${index}`} value={header}>{header}</option>
                                    ))}
                                </select>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Live Preview Table of Mapped SAP Rows */}
                <div className="mt-5 bg-white p-4 rounded-lg border border-gray-200">
                    <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                        <h4 className="text-xs font-bold text-gray-700 uppercase tracking-wide">
                            Muestra de Registros Extraídos (Primeras filas)
                        </h4>
                        <input
                            type="text"
                            value={previewFilter}
                            onChange={e => setPreviewFilter(e.target.value)}
                            placeholder="🔍 Filtrar muestra..."
                            className="border border-gray-300 rounded px-2.5 py-1 text-xs w-48 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                        />
                    </div>
                    <div className="overflow-auto max-h-64 border rounded border-gray-200">
                        <table className="min-w-full text-[11px] border-collapse">
                            <thead className="bg-gray-100 text-gray-700 sticky top-0">
                                <tr>
                                    <th className="px-2 py-1.5 text-left border-r">#</th>
                                    <th className="px-2 py-1.5 text-left border-r font-semibold text-blue-800">ECN (Mapeado)</th>
                                    <th className="px-2 py-1.5 text-left border-r font-semibold">Assembly</th>
                                    <th className="px-2 py-1.5 text-left border-r font-semibold">Comp. Anterior</th>
                                    <th className="px-2 py-1.5 text-left border-r font-semibold">Comp. Nuevo</th>
                                    <th className="px-2 py-1.5 text-left border-r font-semibold">Fecha Inicio</th>
                                    <th className="px-2 py-1.5 text-left font-semibold">Desc. Ensamble</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredRows.map((row, idx) => (
                                    <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                                        <td className="px-2 py-1 border-r text-gray-400">{idx + 1}</td>
                                        <td className="px-2 py-1 border-r font-medium text-blue-900">{mappings.ecn ? String(row[mappings.ecn] || '') : '-'}</td>
                                        <td className="px-2 py-1 border-r">{mappings.assembly ? String(row[mappings.assembly] || '') : '-'}</td>
                                        <td className="px-2 py-1 border-r">{mappings.oldComponent ? String(row[mappings.oldComponent] || '') : '-'}</td>
                                        <td className="px-2 py-1 border-r">{mappings.newComponent ? String(row[mappings.newComponent] || '') : '-'}</td>
                                        <td className="px-2 py-1 border-r">{mappings.startDate ? String(row[mappings.startDate] || '') : '-'}</td>
                                        <td className="px-2 py-1 truncate max-w-xs">{mappings.assemblyDescription ? String(row[mappings.assemblyDescription] || '') : '-'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div className="mt-5 flex justify-end space-x-3">
                    <Button variant="secondary" onClick={handleCancel} disabled={isLoading}>
                        Cancelar
                    </Button>
                    <Button
                        variant="primary"
                        onClick={handleProcessImport}
                        disabled={isLoading || !mappings.ecn}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2 font-semibold"
                    >
                        {isLoading ? 'Procesando...' : 'Confirmar e Importar'}
                    </Button>
                </div>

                {showSiteModal && (
                    <div className="fixed inset-0 bg-black bg-opacity-50 z-[100] flex justify-center items-center p-4">
                        <Card className="max-w-md w-full">
                            <h3 className="text-lg font-semibold text-gray-800 mb-4">Seleccionar Sitio</h3>
                            <p className="text-sm text-gray-600 mb-4">
                                Ha indicado que esta extracción pertenece a un sitio diferente a 5201. Por favor seleccione el sitio:
                            </p>
                            <select
                                value={selectedSite}
                                onChange={(e) => setSelectedSite(e.target.value)}
                                className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-red bg-white text-gray-900 mb-6"
                            >
                                <option value="5205">5205</option>
                                <option value="5382">5382</option>
                                <option value="4438">4438</option>
                                <option value="5731">5731</option>
                            </select>
                            <div className="flex justify-end space-x-2">
                                <Button variant="secondary" onClick={() => setShowSiteModal(false)}>Cancelar</Button>
                                <Button variant="primary" onClick={handleProcessImport}>Confirmar y Procesar</Button>
                            </div>
                        </Card>
                    </div>
                )}

                <ImportProgressModal
                    isOpen={isLoading && importProgress !== null}
                    percent={importProgress?.percent || 0}
                    stage={importProgress?.stage}
                    current={importProgress?.current}
                    total={importProgress?.total}
                    newCount={importProgress?.newCount}
                    updatedCount={importProgress?.updatedCount}
                    title="Sincronizando e Importando Datos SAP"
                />
            </Card>
        );
    }

    // ---- RENDER: Step 1 Select & Execute Form ----
    return (
        <Card className="border-2 border-emerald-500/40 bg-gradient-to-r from-emerald-50/70 to-teal-50/70 shadow-md">
            <div className="flex items-start justify-between flex-wrap gap-4">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2 flex-wrap gap-2">
                        <span className="px-2.5 py-1 text-xs font-bold bg-emerald-600 text-white rounded-full uppercase tracking-wide">
                            1-CLIC AUTOMÁTICO (SIN ARCHIVO)
                        </span>
                        <h2 className="text-xl font-bold text-emerald-900">
                            Sincronización Automatizada Directa desde SAP
                        </h2>
                    </div>
                    <p className="text-sm text-gray-700 my-2 max-w-3xl">
                        Extrae y consolida datos de SAP automáticamente mediante SAP GUI Scripting. Permite previsualizar y mapear columnas antes de importar a la base de datos.
                    </p>
                </div>
                <button
                    onClick={() => setShowMxohConfig(v => !v)}
                    className="text-xs text-gray-500 hover:text-emerald-700 underline self-start mt-1"
                    title="Configuración avanzada MXOH"
                >
                    ⚙️ Configuración MXOH
                </button>
            </div>

            {showMxohConfig && (
                <div className="mt-3 p-4 bg-amber-50 border border-amber-300 rounded-lg">
                    <h3 className="text-sm font-semibold text-amber-800 mb-1">Configuración MXOH — Planta 5201</h3>
                    <p className="text-xs text-amber-700 mb-3">
                        Para habilitar la Planta 5201, escriba <code className="bg-amber-100 px-1 rounded">true</code> en el campo y guarde. Para deshabilitar, borre el valor o escriba <code className="bg-amber-100 px-1 rounded">false</code>.
                    </p>
                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            value={mxohInput}
                            onChange={e => setMxohInput(e.target.value)}
                            placeholder="true / false"
                            className="border border-amber-400 rounded px-3 py-1.5 text-sm w-36 bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
                        />
                        <button
                            onClick={handleSaveMxoh}
                            disabled={isSavingMxoh}
                            className="bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold px-4 py-1.5 rounded transition-colors disabled:opacity-60"
                        >
                            {isSavingMxoh ? 'Guardando...' : 'Guardar'}
                        </button>
                        <span className={`text-xs font-medium ${mxohEnabled ? 'text-emerald-700' : 'text-gray-500'}`}>
                            Estado actual: <strong>{mxohEnabled ? '✅ Habilitado' : '🔒 Deshabilitado'}</strong>
                        </span>
                    </div>
                </div>
            )}

            <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
                <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">Fecha Inicio</label>
                    <input
                        type="date"
                        value={startDate}
                        onChange={e => setStartDate(e.target.value)}
                        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    />
                </div>
                <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">Fecha Fin</label>
                    <input
                        type="date"
                        value={endDate}
                        onChange={e => setEndDate(e.target.value)}
                        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    />
                </div>
                <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">Sitio / Planta</label>
                    <select
                        value={plant}
                        onChange={e => setPlant(e.target.value)}
                        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    >
                        <option value="5205">5205 (Default)</option>
                        <option value="5731">5731</option>
                        <option value="5382">5382</option>
                        <option value="4438">4438</option>
                        <option value="5201" disabled={!mxohEnabled}>
                            {mxohEnabled ? '5201 (MXOH — Habilitado)' : '5201 (Deshabilitado — requiere config MXOH)'}
                        </option>
                    </select>
                </div>
            </div>

            <div className="flex items-center flex-wrap gap-4 mt-5">
                <Button
                    onClick={handleRunAutomatedExtraction}
                    disabled={isLoading || isUpdatingDescriptions}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2.5 rounded-lg text-sm font-semibold shadow-md transition-all flex items-center space-x-2"
                >
                    {isLoading ? (
                        <>
                            <span className="animate-spin inline-block mr-2">⏳</span>
                            <span>Extrayendo y cargando mapeo...</span>
                        </>
                    ) : (
                        <span>⚡ Ejecutar Sincronización Automatizada SAP</span>
                    )}
                </Button>

                {/* BOTÓN APARTE: Paso 5 para actualizar descripciones de ECNs que no tienen en la base de datos vía SAP WebGUI / IQS3 */}
                <Button
                    variant="secondary"
                    onClick={handleUpdateMissingDescriptions}
                    disabled={isLoading}
                    className="border-blue-400 text-blue-800 hover:bg-blue-50 px-4 py-2.5 rounded-lg text-sm font-medium transition-all flex items-center space-x-2"
                >
                    <span>🚀 Transacción IQS3 (I1S3): Extraer Descripciones de ECNs</span>
                </Button>

                {isLoading && (
                    <span className="text-xs text-gray-500 italic">Extrayendo datos de SAP GUI...</span>
                )}
            </div>

            {showSapDescModal && (
                <SapDescriptionsSyncModal
                    isOpen={showSapDescModal}
                    onClose={() => setShowSapDescModal(false)}
                    onUpdated={onImport}
                    setNotification={setNotification}
                />
            )}

            {showSapSessionModal && (
                <Modal isOpen={showSapSessionModal} onClose={() => setShowSapSessionModal(false)} title="SAP: Sesión no iniciada">
                    <div className="space-y-3">
                        <p>Se detectó SAP GUI en el equipo pero no se encontró una sesión activa con credenciales. Por favor inicie sesión en SAP (seleccione el sistema y autentíquese) y luego pulse <strong>Reintentar</strong>.</p>
                        {sapSessionLogs && sapSessionLogs.length > 0 && (
                            <div className="p-2 border rounded bg-gray-50 text-xs max-h-40 overflow-auto">
                                {sapSessionLogs.map((l, i) => (
                                    <div key={i} className="whitespace-pre-wrap">{l}</div>
                                ))}
                            </div>
                        )}
                        <div className="mt-2">
                            <label className="text-xs font-semibold">Nombre del sistema SAP (opcional)</label>
                            <input
                                type="text"
                                value={sapSystemInput}
                                onChange={e => setSapSystemInput(e.target.value)}
                                placeholder="Ej. BRP"
                                className="w-full border rounded px-2 py-1 text-sm mt-1"
                                disabled={sapSystemLoading}
                            />
                        </div>
                        <div className="flex justify-end space-x-2">
                            <Button variant="secondary" onClick={() => setShowSapSessionModal(false)}>Cancelar</Button>
                            <Button variant="primary" onClick={handleRetryFromModal}>Reintentar</Button>
                        </div>
                    </div>
                </Modal>
            )}
        </Card>
    );
};




// --- Main Changes Component ---

const Changes: React.FC<ChangesProps> = ({ onDataChange }) => {
    const navigate = useNavigate();
    const [activeTab, setActiveTab] = useState<'ecns' | 'import' | 'audit'>('ecns');
    const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
    const [logKey, setLogKey] = useState(Date.now());
    const [ecns, setEcns] = useState<ECN[]>([]);
    const [isLoadingEcns, setIsLoadingEcns] = useState(true);
    const [ecnsError, setEcnsError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [confirmation, setConfirmation] = useState<{ title: string; message: React.ReactNode; onConfirm: () => void } | null>(null);
    const [updatingEcnId, setUpdatingEcnId] = useState<string | null>(null);
    const [selectedEcnForDescModal, setSelectedEcnForDescModal] = useState<string | null>(null);

    const handleUpdateSingleDescription = (ecnId: string) => {
        setSelectedEcnForDescModal(ecnId);
    };

    const fetchEcns = useCallback(async () => {
        setIsLoadingEcns(true);
        setEcnsError(null);
        try {
            const data = await api.getEcns({ timeFilter: 'Todos' }); // Fetch all
            setEcns(data);
        } catch (err) {
            setEcnsError('No se pudieron cargar los ECNs.');
            console.error(err);
        } finally {
            setIsLoadingEcns(false);
        }
    }, []);

    useEffect(() => {
        fetchEcns();
    }, [fetchEcns]);

    const filteredEcns = useMemo(() => {
        if (!search.trim()) {
            return ecns;
        }
        const keywords = search.toLowerCase().split(/\s+/).filter(Boolean);
        return ecns.filter(ecn => {
            const searchableContent = [
                ecn.id,
                ecn.initiator,
                ecn.description || '',
                ecn.status,
                // Also search in aggregated lists if available
                ecn.skuList || '',
                ecn.oldComponentList || '',
                ecn.newComponentList || ''
            ].join(' ').toLowerCase();
            return keywords.every(keyword => searchableContent.includes(keyword));
        });
    }, [ecns, search]);

    const handleDelete = (ecn: ECN) => {
        setConfirmation({
            title: 'Confirmar Eliminación',
            message: <>¿Está seguro de que desea eliminar el ECN <strong>{ecn.id}</strong>? Esta acción es permanente.</>,
            onConfirm: async () => {
                try {
                    await api.deleteEcn(ecn.id);
                    setNotification({ message: `ECN ${ecn.id} eliminado correctamente.`, type: 'success' });
                    fetchEcns(); // Refetch the list
                    onDataChange(); // Notify parent of change
                } catch (error) {
                    console.error("Failed to delete ECN", error);
                    setNotification({ message: 'Error al eliminar el ECN.', type: 'error' });
                } finally {
                    setConfirmation(null);
                }
            }
        });
    };

    const handleExportExistingEcnsCsv = () => {
        if (filteredEcns.length === 0) {
            setNotification({ message: 'No hay datos para exportar según el filtro actual.', type: 'error' });
            return;
        }
        const dataToExport = filteredEcns.map(ecn => {
            // Use pre-aggregated fields or fallback
            return {
                'ECN': ecn.id,
                'Iniciador': ecn.initiator,
                'Descripción': ecn.description || '—',
                'Fecha Imp.': ecn.implementationDate ? ecn.implementationDate.substring(0, 10) : '—',
                'SKUs': ecn.skuList || '',
                'Comp. Viejo': ecn.oldComponentList || '',
                'Comp. Nuevo': ecn.newComponentList || '',
                'Estatus': ecn.status
            };
        });
        exportToCsv(`ecns_existentes_${new Date().toISOString().split('T')[0]}.csv`, dataToExport);
    };

    const handleImportSuccess = useCallback(() => {
        onDataChange();
        fetchEcns();
        setLogKey(Date.now());
    }, [onDataChange, fetchEcns]);

    return (
        <div className="space-y-6">
            {notification && <Toast message={notification.message} type={notification.type} onClose={() => setNotification(null)} />}
            
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-gray-800">Gestión de Cambios e Importaciones</h1>
                    <p className="text-gray-600 mt-1">Administre los ECNs registrados, sincronice directamente con SAP (WebGUI o Escritorio) e importe archivos de reporte.</p>
                </div>
            </div>

            {/* Pestañas Principales de Navegación */}
            <div className="flex border-b border-gray-200 gap-2">
                <button
                    type="button"
                    onClick={() => setActiveTab('ecns')}
                    className={`flex items-center gap-2 py-3 px-5 text-sm font-semibold border-b-2 transition-all ${
                        activeTab === 'ecns'
                            ? 'border-brand-red text-brand-red bg-red-50/50 rounded-t-lg'
                            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                >
                    <span>📋 ECNs Existentes</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                        activeTab === 'ecns' ? 'bg-brand-red text-white' : 'bg-gray-200 text-gray-700'
                    }`}>
                        {filteredEcns.length}
                    </span>
                </button>

                <button
                    type="button"
                    onClick={() => setActiveTab('import')}
                    className={`flex items-center gap-2 py-3 px-5 text-sm font-semibold border-b-2 transition-all ${
                        activeTab === 'import'
                            ? 'border-brand-red text-brand-red bg-red-50/50 rounded-t-lg'
                            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                >
                    <span>🔄 Importación y Sincronización SAP</span>
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        WebGUI & Excel
                    </span>
                </button>

                <button
                    type="button"
                    onClick={() => setActiveTab('audit')}
                    className={`flex items-center gap-2 py-3 px-5 text-sm font-semibold border-b-2 transition-all ${
                        activeTab === 'audit'
                            ? 'border-brand-red text-brand-red bg-red-50/50 rounded-t-lg'
                            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                >
                    <span>📜 Historial y Auditoría</span>
                </button>
            </div>

            {/* TAB 1: ECNs Existentes (Grid Principal por defecto) */}
            {activeTab === 'ecns' && (
                <Card>
                    <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 mb-4">
                        <div>
                            <h2 className="text-xl font-semibold text-gray-800">ECNs Existentes ({filteredEcns.length})</h2>
                            <p className="text-xs text-gray-500 mt-0.5">Doble clic en cualquier fila para abrir el editor de cambios.</p>
                        </div>
                        <div className="flex items-center gap-3">
                            <input
                                type="text"
                                placeholder="Buscar por ID, iniciador, descripción, componente..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className="w-72 sm:w-96 px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-red bg-gray-100 text-gray-900 text-sm"
                            />
                            <Button onClick={handleExportExistingEcnsCsv} className="whitespace-nowrap">
                                📥 Exportar CSV
                            </Button>
                        </div>
                    </div>
                    
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    {['ECN', 'Iniciador', 'Descripción', 'Fecha Imp.', 'SKUs', 'Comp. Viejo', 'Comp. Nuevo', 'Estatus', 'Acciones'].map(header => (
                                        <th key={header} scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{header}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {isLoadingEcns ? (
                                    <tr><td colSpan={9} className="text-center py-6 text-gray-500">Cargando ECNs...</td></tr>
                                ) : ecnsError ? (
                                    <tr><td colSpan={9} className="text-center py-6 text-red-500">{ecnsError}</td></tr>
                                ) : filteredEcns.length === 0 ? (
                                    <tr><td colSpan={9} className="text-center py-6 text-gray-500">No se encontraron ECNs que coincidan con la búsqueda.</td></tr>
                                ) : (
                                    filteredEcns.map(ecn => {
                                        return (
                                            <tr
                                                key={ecn.id}
                                                className="hover:bg-gray-50 cursor-pointer transition-colors"
                                                onDoubleClick={() => navigate(`/edit/${ecn.id}`)}
                                            >
                                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{ecn.id}</td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{ecn.initiator}</td>
                                                <td className="px-6 py-4 text-sm text-gray-500 max-w-sm">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="truncate flex-1" title={ecn.description || ''}>
                                                            {ecn.description || '—'}
                                                        </span>
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleUpdateSingleDescription(ecn.id);
                                                            }}
                                                            disabled={updatingEcnId === ecn.id}
                                                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 transition-colors disabled:opacity-50 flex-shrink-0"
                                                            title={`Consultar y actualizar descripción de ${ecn.id} desde SAP GUI`}
                                                        >
                                                            {updatingEcnId === ecn.id ? (
                                                                <>
                                                                    <span className="animate-spin text-[10px]">⏳</span>
                                                                    <span>Actualizando...</span>
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <span>🔄</span>
                                                                    <span>Actualizar</span>
                                                                </>
                                                            )}
                                                        </button>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{ecn.implementationDate ? ecn.implementationDate.substring(0, 10) : '—'}</td>

                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 max-w-[150px] truncate" title={ecn.skuList}>
                                                    {ecn.skuList || '—'}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 max-w-[150px] truncate" title={ecn.oldComponentList}>
                                                    {ecn.oldComponentList || '—'}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 max-w-[150px] truncate" title={ecn.newComponentList}>
                                                    {ecn.newComponentList || '—'}
                                                </td>

                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500"><StatusBadge status={ecn.status} /></td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                                                    <Button variant="danger" onClick={(e) => { e.stopPropagation(); handleDelete(ecn); }}>Eliminar</Button>
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                </Card>
            )}

            {/* TAB 2: Todas las Opciones de Importación y Sincronización SAP */}
            {activeTab === 'import' && (
                <div className="space-y-6">
                    {/* Opción Nueva y Separada: SAP WebGUI */}
                    <SapWebGuiImporter onImport={handleImportSuccess} setNotification={setNotification} />

                    {/* Sincronización Directa SAP GUI de Escritorio */}
                    <DirectAutomatedSync onImport={handleImportSuccess} setNotification={setNotification} />

                    {/* Sincronización Asistida por Macro / VBScript */}
                    <AutomatedVbaImporter onImport={handleImportSuccess} setNotification={setNotification} />

                    {/* Importador Manual de Reporte SAP (Excel) */}
                    <SapReportImporter onImport={handleImportSuccess} setNotification={setNotification} />

                    {/* Importadores Complementarios */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <DescriptionImporter onImport={handleImportSuccess} setNotification={setNotification} />
                        <SkuFamilyImporter onImport={handleImportSuccess} setNotification={setNotification} />
                    </div>
                </div>
            )}

            {/* TAB 3: Historial y Auditoría */}
            {activeTab === 'audit' && (
                <AuditTrail key={logKey} />
            )}

            {confirmation && (
                <ConfirmationModal
                    isOpen={!!confirmation}
                    onClose={() => setConfirmation(null)}
                    onConfirm={confirmation.onConfirm}
                    title={confirmation.title}
                    message={confirmation.message}
                />
            )}

            {selectedEcnForDescModal && (
                <SapDescriptionsSyncModal
                    isOpen={!!selectedEcnForDescModal}
                    onClose={() => setSelectedEcnForDescModal(null)}
                    initialEcn={selectedEcnForDescModal}
                    onUpdated={() => {
                        fetchEcns();
                        onDataChange();
                    }}
                    setNotification={setNotification}
                />
            )}
        </div>
    );
};

export default Changes;
