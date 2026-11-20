import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { Card, Button, Modal, ImportProgressModal } from './ui';
import * as api from '../services/api';
import { ECN, ECNStatus, ComponentChange } from '../types';

interface SapWebGuiImporterProps {
    onImport: () => void;
    setNotification: (n: { message: string, type: 'success' | 'error' } | null) => void;
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

export const SapWebGuiImporter: React.FC<SapWebGuiImporterProps> = ({ onImport, setNotification }) => {
    // Connection parameters
    const [webGuiUrl, setWebGuiUrl] = useState('https://brpwas.honeywell.com/sap/bc/gui/sap/its/webgui/');
    const [transaction, setTransaction] = useState('ZPP_CC07');
    const [plant, setPlant] = useState('5205');
    const [variant, setVariant] = useState('ECN5205');
    const today = new Date().toISOString().split('T')[0];
    const oneYearAgo = new Date(new Date().setFullYear(new Date().getFullYear() - 1)).toISOString().split('T')[0];
    const [startDate, setStartDate] = useState(oneYearAgo);
    const [endDate, setEndDate] = useState(today);
    
    // UI state
    const [showScriptModal, setShowScriptModal] = useState(false);
    const [scriptModalTab, setScriptModalTab] = useState<'bat' | 'js'>('bat');
    const [showInstructions, setShowInstructions] = useState(false);
    const [scriptCopied, setScriptCopied] = useState(false);
    const [batCopied, setBatCopied] = useState(false);

    // Import file states
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

    const [cs15Loading, setCs15Loading] = useState(false);
    const [cs15Result, setCs15Result] = useState<any>(null);

    const handleRunCs15Sync = async () => {
        setCs15Loading(true);
        setCs15Result(null);
        try {
            const res = await fetch('/api/sap/sync-cs15-skus', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await res.json();
            if (data.success) {
                setCs15Result(data);
                setNotification({ message: data.message || 'CS15 ejecutado exitosamente.', type: 'success' });
            } else {
                setNotification({ message: data.error || 'Error ejecutando CS15.', type: 'error' });
            }
        } catch (e: any) {
            setNotification({ message: e.message || 'Error de conexión con el servidor.', type: 'error' });
        } finally {
            setCs15Loading(false);
        }
    };

    // Format date for SAP parameters (DD.MM.YYYY)
    const formatSapDate = (isoDate: string) => {
        if (!isoDate) return '';
        const [y, m, d] = isoDate.split('-');
        return `${d}.${m}.${y}`;
    };

    // Build the direct WebGUI URL with parameters or Variant
    // SAP ITS WebGUI format:
    // Option 1: Via Variant: ~transaction=ZPP_CC07 V=ECN5205  or ~transaction=*ZPP_CC07 V=ECN5205
    // Option 2: Via Direct Parameters: ~transaction=ZPP_CC07 P_WERKS=5205;SO_AEDAT-LOW=...
    const getComputedWebGuiUrl = (mode: 'variant' | 'params' | 'auto_variant' = 'variant') => {
        let base = webGuiUrl.trim();
        if (!base.endsWith('/')) base += '/';

        const tx = transaction.trim();

        if (mode === 'variant' || mode === 'auto_variant') {
            const vName = variant.trim();
            const txPrefix = mode === 'auto_variant' ? '*' : '';
            const transactionParam = vName ? `${txPrefix}${tx} V=${vName}` : `${txPrefix}${tx}`;
            return `${base}?~transaction=${encodeURIComponent(transactionParam)}&~okcode=/00`;
        }

        const sapStart = formatSapDate(startDate);
        const sapEnd = formatSapDate(endDate);

        // Technical field names for ZPP_CC07
        const paramPairs = [
            `P_WERKS=${plant.trim()}`,
            `SO_AEDAT-LOW=${sapStart}`,
            `SO_AEDAT-HIGH=${sapEnd}`
        ];
        const paramsString = paramPairs.join(';');
        const transactionParam = `${tx} ${paramsString}`;
        
        return `${base}?~transaction=${encodeURIComponent(transactionParam)}&~okcode=/00`;
    };

    const handleOpenWebGui = (mode: 'variant' | 'params' | 'auto_variant' = 'variant') => {
        const url = getComputedWebGuiUrl(mode);
        window.open(url, '_blank', 'noopener,noreferrer');
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
            const trimmedDate = dateInput.trim().split('T')[0].split(' ')[0];
            let parts;
            let year, month, day;
            parts = trimmedDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
            if (parts) {
                year = parseInt(parts[1], 10); month = parseInt(parts[2], 10) - 1; day = parseInt(parts[3], 10);
            }
            if (!parts) {
                parts = trimmedDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                if (parts) { year = parseInt(parts[3], 10); month = parseInt(parts[1], 10) - 1; day = parseInt(parts[2], 10); }
            }
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

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setIsLoading(true);
        setNotification(null);
        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data, { cellDates: true });
            const outputSheetName = workbook.SheetNames.find(s => s.trim().toLowerCase() === 'output');
            const sheetName = outputSheetName || workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];

            const allRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null }) as any[][];
            if (allRows.length < 1) {
                throw new Error("El archivo está vacío o no contiene encabezados.");
            }

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
            const parsedData = rawData.map(row => {
                const rowObj: any = {};
                parsedHeaders.forEach((header, index) => {
                    rowObj[header] = row[index];
                });
                return rowObj;
            });

            const initialMappings: Record<string, string> = {};
            for (const key in MAPPABLE_FIELDS) {
                const field = MAPPABLE_FIELDS[key];
                const allAliases = [field.label.toLowerCase(), ...(field.aliases || [])];
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

    const handleCancel = () => {
        setStep('select');
        setFileName(null);
        setHeaders([]);
        setJsonData([]);
        setMappings({});
        setIsOtherSite(false);
        setShowSiteModal(false);
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

            const existingEcnsMap = new Map(existingEcns.map(e => [e.id, e]));
            const ecnsToUpsertMap = new Map<string, ECN>();
            const todayStr = new Date().toISOString().split('T')[0];
            const currentSite = isOtherSite ? selectedSite : '5205';

            jsonData.forEach(row => {
                if (mappings.plant && row[mappings.plant] !== undefined && row[mappings.plant] !== null) {
                    const plantVal = String(row[mappings.plant]).trim();
                    if (plantVal === '5201') {
                        return;
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
                            initiator: String(row[mappings.createdBy] || 'Sistema WebGUI'),
                            description: String(row[mappings.assemblyDescription] || `ECN importado ${ecnId}`),
                            status: ECNStatus.Pending,
                            creationDate: parseDate(row[mappings.createdOn]) || todayStr,
                            implementationDate: '',
                            daysRemaining: 0,
                            changes: [], notes: [], auditLog: [], checklist: []
                        };
                    }
                }

                if (!ecn) return;

                const startDate = parseDate(row[mappings.startDate]);
                if (!startDate) return;

                const newDemand = Number(row[mappings.demand]) || 0;
                const newOnHand = Number(row[mappings.onHandInventory]) || 0;
                const newOpenPo = Number(row[mappings.openPoQty]) || 0;
                const skuVal = mappings.sku && row[mappings.sku] ? String(row[mappings.sku]).trim() : undefined;
                const familyVal = mappings.family && row[mappings.family] ? String(row[mappings.family]).trim() : (isOtherSite ? 'VESDA' : undefined);

                const newChangeValues: ComponentChange = {
                    id: ``,
                    assembly,
                    oldComponent,
                    newComponent,
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

                if (isNewEcn || componentChanged) {
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

            await api.upsertEcns(finalEcnsToUpsert, fileName || 'SAP_WebGUI_Report.xlsx', (prog: any) => {
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

            setNotification({
                message: `Sincronización WebGUI completada: ${finalEcnsToUpsert.length} ECNs procesados exitosamente.`,
                type: 'success'
            });

            handleCancel();
            onImport();
        } catch (err: any) {
            console.error('Error al procesar importación WebGUI:', err);
            setNotification({ message: err.message || 'Error durante la importación de datos.', type: 'error' });
        } finally {
            setIsLoading(false);
            setImportProgress(null);
        }
    };

    const playwrightScript = `/**
 * Automatización Headless de SAP WebGUI con Playwright
 * Ejecutable en Windows / Linux dentro de la red corporativa de Honeywell
 */
const { chromium } = require('playwright');
const fs = require('fs');

async function syncSapWebGui() {
    console.log('[SAP WebGUI] Iniciando navegador con perfil corporativo (SSO)...');
    
    // Inicia Chromium/Edge utilizando las credenciales corporativas de Windows
    const browser = await chromium.launch({ 
        headless: true, // Cambia a false si deseas ver la ventana
        channel: 'msedge' // Utiliza Microsoft Edge corporativo instalado
    });
    
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    try {
        console.log('[SAP WebGUI] Navegando a ${webGuiUrl} ...');
        await page.goto('${webGuiUrl}?~transaction=${transaction}', { waitUntil: 'networkidle' });

        console.log('[SAP WebGUI] Configurando parámetros: Planta ${plant}, Rango: ${startDate} al ${endDate} ...');
        
        // Completar campos de la transacción ZPP_CC07
        await page.locator('input[title*="Plant"], input[id*="WERKS"]').fill('${plant}');
        await page.locator('input[title*="Fecha"], input[id*="AEDAT-LOW"]').fill('${formatSapDate(startDate)}');
        await page.locator('input[title*="Hasta"], input[id*="AEDAT-HIGH"]').fill('${formatSapDate(endDate)}');

        // Ejecutar (tecla F8 en SAP)
        console.log('[SAP WebGUI] Ejecutando transacción (F8)...');
        await page.keyboard.press('F8');
        await page.waitForTimeout(4000);

        // Exportar a Excel
        console.log('[SAP WebGUI] Descargando reporte en Excel...');
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator('div[title*="Spreadsheet"], div[title*="Hoja de cálculo"], [id*="btn[16]"]').click()
        ]);

        const savePath = './downloads/SAP_WebGUI_${plant}_' + Date.now() + '.xlsx';
        await download.saveAs(savePath);
        console.log('[SAP WebGUI] Archivo guardado con éxito en:', savePath);
        console.log('[SAP WebGUI] Sincronización finalizada exitosamente.');
    } catch (err) {
        console.error('[SAP WebGUI] Error:', err);
    } finally {
        await browser.close();
    }
}

syncSapWebGui();
`;

    const handleCopyScript = () => {
        navigator.clipboard.writeText(playwrightScript);
        setScriptCopied(true);
        setTimeout(() => setScriptCopied(false), 3000);
    };

    const batScript = `@echo off
setlocal enabledelayedexpansion
title Honeywell ECN Manager - Sincronizacion SAP WebGUI

echo =========================================================================
echo   HONEYWELL ECN MANAGER - AUTOMATIZADOR SAP WEBGUI (EDGE + SSO)
echo =========================================================================
echo Fecha y Hora: %date% %time%
echo Planta SAP:   ${plant}
echo Rango:        ${startDate} al ${endDate}
echo =========================================================================
echo.

:: 1. Verificar Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR CRITICO] Node.js no esta instalado en este equipo.
    echo Por favor instale Node.js LTS desde https://nodejs.org
    echo O ejecute en PowerShell: winget install OpenJS.NodeJS.LTS
    echo.
    pause
    exit /b 1
)

:: 2. Ubicacion
cd /d "%~dp0"

:: 3. Verificar o instalar Playwright
if not exist "node_modules\\playwright" (
    echo [1/3] Configurando Playwright para Microsoft Edge por primera vez...
    call npm install playwright --no-audit --no-fund --loglevel=error
)

:: 4. Generar script runner.js
echo [2/3] Preparando script de automatizacion...
(
    echo const { chromium } = require('playwright'^);
    echo const path = require('path'^);
    echo const fs = require('fs'^);
    echo async function run(^) {
    echo   console.log('[SAP WebGUI] Iniciando Microsoft Edge corporativo con SSO...'^);
    echo   const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--start-maximized'] }^);
    echo   const context = await browser.newContext({ acceptDownloads: true }^);
    echo   const page = await context.newPage(^);
    echo   console.log('[SAP WebGUI] Navegando a ${webGuiUrl}...'^);
    echo   await page.goto('${webGuiUrl}?~transaction=${transaction}', { waitUntil: 'domcontentloaded', timeout: 60000 }^);
    echo   await page.waitForTimeout(5000^);
    echo   console.log('[SAP WebGUI] Completando filtros: Planta ${plant}, ${formatSapDate(startDate)} a ${formatSapDate(endDate)}...'^);
    echo   const plantIn = page.locator('input[title*="Plant" i], input[id*="WERKS" i]'^).first(^);
    echo   if (await plantIn.count(^) ^> 0^) await plantIn.fill('${plant}'^);
    echo   const dLow = page.locator('input[id*="AEDAT-LOW" i], input[title*="Fecha" i]'^).first(^);
    echo   if (await dLow.count(^) ^> 0^) await dLow.fill('${formatSapDate(startDate)}'^);
    echo   const dHigh = page.locator('input[id*="AEDAT-HIGH" i], input[title*="Hasta" i]'^).first(^);
    echo   if (await dHigh.count(^) ^> 0^) await dHigh.fill('${formatSapDate(endDate)}'^);
    echo   console.log('[SAP WebGUI] Ejecutando reporte ZPP_CC07 (F8)...'^);
    echo   await page.keyboard.press('F8'^);
    echo   await page.waitForTimeout(7000^);
    echo   console.log('[SAP WebGUI] Solicitando exportacion a Excel...'^);
    echo   const downloadPromise = page.waitForEvent('download', { timeout: 45000 }^).catch((^) =^> null^);
    echo   const expBtn = page.locator('div[title*="Spreadsheet" i], div[title*="Hoja de cálculo" i], div[id*="btn[16]" i]'^).first(^);
    echo   if (await expBtn.count(^) ^> 0^) { await expBtn.click(^); } else { await page.keyboard.press('Control+Shift+F7'^); }
    echo   await page.waitForTimeout(2000^);
    echo   const confirmBtn = page.locator('div[title*="Continue" i], div[title*="Continuar" i], div[id*="btn[0]" i]'^).first(^);
    echo   if (await confirmBtn.count(^) ^> 0^) await confirmBtn.click(^);
    echo   const download = await downloadPromise;
    echo   if (download^) {
    echo     const outDir = path.join(process.cwd(^), 'downloads'^);
    echo     if (!fs.existsSync(outDir^)^) fs.mkdirSync(outDir, { recursive: true }^);
    echo     const savePath = path.join(outDir, 'SAP_WebGUI_${plant}_' + Date.now(^) + '.xlsx'^);
    echo     await download.saveAs(savePath^);
    echo     console.log('================================================================'^);
    echo     console.log(' [OK] REPORTE DESCARGADO CON EXITO EN:'^);
    echo     console.log(' ' + savePath^);
    echo     console.log('================================================================'^);
    echo   } else {
    echo     console.log('[AVISO] Si Edge mostro un dialogo, guarde el archivo manualmente.'^);
    echo   }
    echo   await page.waitForTimeout(4000^);
    echo   await browser.close(^);
    echo }
    echo run(^);
) > sync_webgui_runner.js

:: 5. Ejecutar
echo [3/3] Ejecutando proceso con Edge...
node sync_webgui_runner.js

echo.
echo =========================================================================
if exist "%~dp0downloads" (
    echo Los archivos descargados estan en: %~dp0downloads
    set /p OPN="Desea abrir la carpeta de descargas? (S/N): "
    if /i "!OPN!"=="S" explorer.exe "%~dp0downloads"
)
echo =========================================================================
echo Presione cualquier tecla para cerrar...
pause >nul
`;

    const handleDownloadBat = () => {
        const element = document.createElement("a");
        const file = new Blob([batScript], { type: 'text/plain;charset=utf-8' });
        element.href = URL.createObjectURL(file);
        element.download = `sync_sap_webgui_${plant}.bat`;
        document.body.appendChild(element);
        element.click();
        document.body.removeChild(element);
    };

    const handleCopyBat = () => {
        navigator.clipboard.writeText(batScript);
        setBatCopied(true);
        setTimeout(() => setBatCopied(false), 3000);
    };

    return (
        <Card className="border-l-4 border-l-blue-600 shadow-sm">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-gray-200">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-blue-700 text-xl font-bold">
                        🌐
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-xl font-bold text-gray-800">Sincronización Directa SAP WebGUI (Portal Web)</h2>
                            <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-blue-100 text-blue-800 border border-blue-200">
                                Sin Instalación de Escritorio
                            </span>
                        </div>
                        <p className="text-sm text-gray-600">
                            Conexión al portal web de SAP Honeywell (<code className="bg-gray-100 px-1 py-0.5 rounded text-xs">brpwas.honeywell.com</code>). No requiere SAP GUI para Windows ni VBScript.
                        </p>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <Button 
                        variant="secondary" 
                        onClick={handleDownloadBat}
                        className="text-xs !py-2 border border-emerald-300 !bg-emerald-50 text-emerald-800 hover:!bg-emerald-100 flex items-center gap-1.5 font-medium"
                    >
                        <span>📥</span>
                        <span>Descargar .BAT</span>
                    </Button>
                    <Button 
                        variant="secondary" 
                        onClick={() => { setScriptModalTab('bat'); setShowScriptModal(true); }}
                        className="text-xs !py-2 border border-gray-300 flex items-center gap-1.5"
                    >
                        <span>🤖 Ver Scripts</span>
                    </Button>
                    <Button 
                        variant="primary" 
                        onClick={() => handleOpenWebGui('variant')}
                        className="!bg-blue-600 hover:!bg-blue-700 text-xs !py-2 flex items-center gap-1.5 font-semibold"
                        title={`Abrir WebGUI invocando la variante ${variant}`}
                    >
                        <span>🚀 Abrir con Variante ({variant || 'ZPP_CC07'})</span>
                        <span>↗</span>
                    </Button>
                    <Button 
                        variant="primary" 
                        onClick={() => handleOpenWebGui('auto_variant')}
                        className="!bg-indigo-600 hover:!bg-indigo-700 text-xs !py-2 flex items-center gap-1.5 font-semibold shadow-sm"
                        title="Abrir y ejecutar directamente la variante en SAP (F8 automático)"
                    >
                        <span>⚡ Ejecutar con Variante (F8 Auto)</span>
                        <span>↗</span>
                    </Button>
                </div>
            </div>

            {/* Parámetros de consulta */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mt-4 bg-slate-50 p-4 rounded-lg border border-slate-200">
                <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Transacción SAP</label>
                    <input 
                        type="text" 
                        value={transaction} 
                        onChange={e => setTransaction(e.target.value.toUpperCase())}
                        className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded bg-white font-mono uppercase focus:ring-1 focus:ring-blue-500"
                        placeholder="ZPP_CC07"
                    />
                </div>
                <div>
                    <label className="block text-xs font-semibold text-blue-700 mb-1 flex items-center gap-1">
                        <span>⭐ Variante SAP</span>
                        <span className="text-[10px] text-gray-500 font-normal">(Recomendado)</span>
                    </label>
                    <input 
                        type="text" 
                        value={variant} 
                        onChange={e => setVariant(e.target.value.toUpperCase())}
                        className="w-full px-3 py-1.5 text-sm border border-blue-300 rounded bg-blue-50/40 font-mono uppercase focus:ring-1 focus:ring-blue-500 font-bold text-blue-900"
                        placeholder="ECN5205"
                    />
                </div>
                <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Planta (Plant)</label>
                    <div className="flex gap-2">
                        <select 
                            value={plant} 
                            onChange={e => setPlant(e.target.value)}
                            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded bg-white focus:ring-1 focus:ring-blue-500"
                        >
                            <option value="5205">5205 (Mexicali Principal)</option>
                            <option value="5201">5201 (Mexicali Secundario)</option>
                            <option value="5204">5204</option>
                            <option value="5206">5206</option>
                        </select>
                    </div>
                </div>
                <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Fecha Inicio</label>
                    <input 
                        type="date" 
                        value={startDate} 
                        onChange={e => setStartDate(e.target.value)}
                        className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded bg-white focus:ring-1 focus:ring-blue-500"
                    />
                </div>
                <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Fecha Fin</label>
                    <input 
                        type="date" 
                        value={endDate} 
                        onChange={e => setEndDate(e.target.value)}
                        className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded bg-white focus:ring-1 focus:ring-blue-500"
                    />
                </div>
            </div>

            {/* Instrucciones y Acceso */}
            <div className="mt-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-gray-600 bg-blue-50/70 p-3 rounded border border-blue-100">
                <div className="flex items-center gap-2">
                    <span className="text-blue-600 font-bold">ℹ️ Flujo WebGUI:</span>
                    <span>Abre la transacción en WebGUI &gt; presiona Ejecutar (F8) &gt; Exporta a Hoja de cálculo &gt; Carga el archivo aquí abajo.</span>
                </div>
                <button 
                    type="button" 
                    onClick={() => setShowInstructions(!showInstructions)}
                    className="text-blue-700 font-medium hover:underline text-xs whitespace-nowrap"
                >
                    {showInstructions ? 'Ocultar detalles ▲' : 'Ver guía detallada ▼'}
                </button>
            </div>

            {showInstructions && (
                <div className="mt-3 p-4 bg-white border border-blue-200 rounded-lg text-xs space-y-3 text-gray-700">
                    <div>
                        <h4 className="font-bold text-gray-900 text-sm mb-1">🌐 Navegador y Extensiones</h4>
                        <ul className="list-disc list-inside space-y-1 ml-1 text-gray-600">
                            <li><b>Navegador recomendado:</b> <u>Microsoft Edge</u> o <u>Google Chrome</u> con tu sesión iniciada de Honeywell. Edge es el oficial porque soporta Windows Authentication / SSO nativo sin pedir contraseñas.</li>
                            <li><b>¿Requiere extensiones?:</b> <b>No</b> se requiere ninguna extensión. Solo asegúrate de estar conectado a la red Honeywell o VPN corporativa.</li>
                        </ul>
                    </div>

                    <div>
                        <h4 className="font-bold text-gray-900 text-sm mb-1">⭐ Cómo guardar tu Variante en SAP (Para no escribir filtros nunca más):</h4>
                        <ol className="list-decimal list-inside space-y-1 ml-1 text-gray-600">
                            <li>Abre <b>ZPP_CC07</b> en WebGUI o SAP GUI de escritorio.</li>
                            <li>Escribe en la casilla <b>Plant</b>: <code>5205</code> y pon tus fechas deseadas.</li>
                            <li>Haz clic en el botón <b>Guardar (Disquete 💾)</b> o presiona <code>Ctrl + S</code>.</li>
                            <li>En <b>Variant Name</b> pon: <code>ECN5205</code> (o el nombre que prefieras).</li>
                            <li>Haz clic en Guardar. ¡Listo! Ahora al presionar <b>Abrir con Variante</b> o <b>Ejecutar con Variante</b>, SAP carga automáticamente tu planta y filtros.</li>
                        </ol>
                    </div>

                    <div>
                        <h4 className="font-bold text-gray-900 text-sm mb-1">📥 Descarga del reporte:</h4>
                        <ol className="list-decimal list-inside space-y-1 ml-1 text-gray-600">
                            <li>En la pantalla de resultados de ZPP_CC07, presiona <code>Ctrl + Shift + F7</code> o el ícono de <b>Hoja de cálculo</b>.</li>
                            <li>Guarda el archivo Excel y arrástralo directamente a la caja punteada aquí abajo.</li>
                        </ol>
                    </div>
                </div>
            )}

            {/* Zona de Carga de Archivo Excel descargado de WebGUI */}
            <div className="mt-5">
                {step === 'select' && (
                    <div className="border-2 border-dashed border-gray-300 hover:border-blue-500 rounded-lg p-6 text-center transition-colors bg-white">
                        <input
                            type="file"
                            id="webgui-file-upload"
                            accept=".xlsx, .xls, .csv"
                            onChange={handleFileChange}
                            disabled={isLoading}
                            className="hidden"
                        />
                        <label htmlFor="webgui-file-upload" className="cursor-pointer flex flex-col items-center justify-center">
                            <span className="text-3xl mb-2">📥</span>
                            <span className="text-sm font-semibold text-gray-800">
                                Arrastre el archivo Excel de WebGUI aquí o haga clic para seleccionarlo
                            </span>
                            <span className="text-xs text-gray-500 mt-1">
                                Compatible con formatos .xlsx, .xls y .csv descargados de la transacción {transaction}
                            </span>
                        </label>
                    </div>
                )}

                {step === 'map' && (
                    <div className="bg-white p-4 border border-gray-200 rounded-lg space-y-4">
                        <div className="flex justify-between items-center pb-2 border-b border-gray-200">
                            <div>
                                <h3 className="font-semibold text-gray-800 text-sm">Mapeo de Columnas ({fileName})</h3>
                                <p className="text-xs text-gray-500">{jsonData.length} filas detectadas en el reporte de SAP WebGUI.</p>
                            </div>
                            <div className="flex gap-2">
                                <Button variant="secondary" onClick={handleCancel} disabled={isLoading} className="text-xs !py-1.5">
                                    Cancelar
                                </Button>
                                <Button variant="primary" onClick={handleProcessImport} disabled={isLoading} className="!bg-blue-600 text-xs !py-1.5 font-semibold">
                                    {isLoading ? 'Procesando...' : `Confirmar e Importar (${jsonData.length} filas)`}
                                </Button>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 max-h-64 overflow-y-auto pr-1">
                            {Object.entries(MAPPABLE_FIELDS).map(([key, field]) => (
                                <div key={key} className="bg-gray-50 p-2 rounded border border-gray-200 text-xs">
                                    <label className="block font-medium text-gray-700 mb-1">
                                        {field.label} {field.required && <span className="text-red-500">*</span>}
                                    </label>
                                    <select
                                        value={mappings[key] || ''}
                                        onChange={e => setMappings(prev => ({ ...prev, [key]: e.target.value }))}
                                        className="w-full text-xs p-1.5 border border-gray-300 rounded bg-white focus:ring-1 focus:ring-blue-500"
                                    >
                                        <option value="">-- No mapear --</option>
                                        {headers.map(h => (
                                            <option key={h} value={h}>{h}</option>
                                        ))}
                                    </select>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Modal de Scripts de Automatización (.BAT y Playwright) */}
            {showScriptModal && (
                <Modal 
                    isOpen={showScriptModal} 
                    onClose={() => setShowScriptModal(false)}
                    title="Automatización SAP WebGUI (.BAT para Windows y Playwright)"
                >
                    <div className="space-y-4">
                        {/* Selector de Pestañas del Modal */}
                        <div className="flex border-b border-gray-200">
                            <button
                                type="button"
                                onClick={() => setScriptModalTab('bat')}
                                className={`py-2 px-4 text-sm font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
                                    scriptModalTab === 'bat'
                                        ? 'border-blue-600 text-blue-600 bg-blue-50/50'
                                        : 'border-transparent text-gray-500 hover:text-gray-700'
                                }`}
                            >
                                <span>📄</span>
                                <span>Archivo .BAT Ejecutable (Recomendado)</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setScriptModalTab('js')}
                                className={`py-2 px-4 text-sm font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
                                    scriptModalTab === 'js'
                                        ? 'border-blue-600 text-blue-600 bg-blue-50/50'
                                        : 'border-transparent text-gray-500 hover:text-gray-700'
                                }`}
                            >
                                <span>💻</span>
                                <span>Script Node.js / Playwright</span>
                            </button>
                        </div>

                        {scriptModalTab === 'bat' && (
                            <div className="space-y-3">
                                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900 space-y-1">
                                    <div className="font-bold flex items-center gap-1.5 text-sm text-emerald-800">
                                        <span>⚡</span>
                                        <span>Ejecución en 1 solo clic en Windows</span>
                                    </div>
                                    <p>
                                        Este script <b>.bat</b> detecta o instala Playwright automáticamente, abre Microsoft Edge con su sesión SSO corporativa de Honeywell, extrae el reporte de la transacción <b>{transaction}</b> para la planta <b>{plant}</b> y guarda el archivo Excel en la carpeta <code>downloads</code>.
                                    </p>
                                </div>

                                <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-100 p-2.5 rounded border border-slate-200 text-xs">
                                    <div className="font-semibold text-gray-700 flex items-center gap-1.5">
                                        <span>📦</span>
                                        <span>Nombre sugerido: <code>sync_sap_webgui_{plant}.bat</code></span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={handleCopyBat}
                                            className="px-3 py-1.5 bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 rounded font-semibold shadow-sm transition-colors"
                                        >
                                            {batCopied ? '¡Copiado!' : '📋 Copiar .BAT'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleDownloadBat}
                                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-semibold shadow-sm transition-colors flex items-center gap-1"
                                        >
                                            <span>📥</span>
                                            <span>Descargar .BAT</span>
                                        </button>
                                    </div>
                                </div>

                                <div className="relative">
                                    <pre className="bg-slate-900 text-slate-100 p-3.5 rounded-lg text-xs overflow-x-auto max-h-72 font-mono leading-relaxed">
                                        {batScript}
                                    </pre>
                                </div>

                                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900 space-y-1">
                                    <h4 className="font-bold text-blue-900">¿Cómo usarlo en Windows?</h4>
                                    <ol className="list-decimal list-inside space-y-1 text-gray-700 ml-1">
                                        <li>Descarga el archivo <code>.bat</code> usando el botón verde de arriba.</li>
                                        <li>Cópialo a una carpeta de tu preferencia (por ejemplo <code>C:\Honeywell\ECN\</code>).</li>
                                        <li>Haz doble clic sobre el archivo para ejecutarlo.</li>
                                        <li>El script abrirá Microsoft Edge, pasará el SSO de Honeywell, descargará el Excel y te abrirá la carpeta de descarga.</li>
                                    </ol>
                                </div>
                            </div>
                        )}

                        {scriptModalTab === 'js' && (
                            <div className="space-y-3">
                                <p className="text-xs text-gray-600">
                                    Código fuente directo en Node.js utilizando el SDK de <b>Playwright</b> con el canal corporativo <code>msedge</code>.
                                </p>
                                <div className="relative">
                                    <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-xs overflow-x-auto max-h-80 font-mono">
                                        {playwrightScript}
                                    </pre>
                                    <button
                                        type="button"
                                        onClick={handleCopyScript}
                                        className="absolute top-3 right-3 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold shadow transition-colors"
                                    >
                                        {scriptCopied ? '¡Copiado!' : 'Copiar Script'}
                                    </button>
                                </div>
                            </div>
                        )}

                        <div className="flex justify-end pt-2 border-t border-gray-200">
                            <Button variant="secondary" onClick={() => setShowScriptModal(false)}>
                                Cerrar
                            </Button>
                        </div>
                    </div>
                </Modal>
            )}

            {/* Modal de Progreso de Importación */}
            {importProgress && (
                <ImportProgressModal
                    isOpen={!!importProgress}
                    percent={importProgress.percent}
                    stage={importProgress.stage}
                    current={importProgress.current}
                    total={importProgress.total}
                    newCount={importProgress.newCount}
                    updatedCount={importProgress.updatedCount}
                />
            )}
            {/* Tarjeta CS15 Where-Used Ensambles con A */}
            <div className="mt-6">
                <Card className="border-l-4 border-l-purple-600 shadow-sm bg-purple-50/30">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-gray-200">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center text-purple-700 text-xl font-bold">
                                ⚙️
                            </div>
                            <div>
                                <div className="flex items-center gap-2">
                                    <h2 className="text-lg font-bold text-gray-800">Automatización CS15: Ensambles con "A" (SKU por Nivel Máximo)</h2>
                                    <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-purple-100 text-purple-800 border border-purple-200">
                                        Transacción CS15
                                    </span>
                                </div>
                                <p className="text-xs text-gray-600">
                                    Ejecuta CS15 para cada ensamble que inicia con la letra "A", hace clic en pantalla siguiente, llena los parámetros (01.01.2026, Centro 5205, Lista variable, A var.niv.), ejecuta y extrae el componente con el mayor nivel (Nv.) como SKU.
                                </p>
                            </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            <a
                                href="/api/sap/download-cs15-bat"
                                className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-semibold shadow transition-colors flex items-center gap-1.5"
                                download="sync_cs15.bat"
                            >
                                <span>📥</span>
                                <span>Descargar .BAT (CS15)</span>
                            </a>
                            <a
                                href="/api/sap/download-cs15-vbs"
                                className="px-3 py-2 bg-slate-700 hover:bg-slate-800 text-white rounded text-xs font-semibold shadow transition-colors flex items-center gap-1.5"
                                download="sync_cs15_skus.vbs"
                            >
                                <span>📜</span>
                                <span>Descargar .VBS</span>
                            </a>
                            <Button
                                variant="primary"
                                onClick={handleRunCs15Sync}
                                disabled={cs15Loading}
                                className="!bg-purple-600 hover:!bg-purple-700 text-xs !py-2 font-semibold flex items-center gap-1.5"
                            >
                                {cs15Loading ? 'Ejecutando CS15...' : '🚀 Ejecutar CS15 (Local Windows)'}
                            </Button>
                        </div>
                    </div>

                    {cs15Result && (
                        <div className="mt-4 p-4 bg-white rounded-lg border border-purple-200 space-y-2">
                            <div className="flex items-center justify-between">
                                <h3 className="font-bold text-sm text-purple-900">Resultado de Ejecución CS15</h3>
                                <span className="text-xs font-mono bg-purple-100 text-purple-800 px-2 py-0.5 rounded">
                                    Actualizados: {cs15Result.updatedCount || cs15Result.updates?.length || 0}
                                </span>
                            </div>
                            <p className="text-xs text-gray-700">{cs15Result.message}</p>
                            {cs15Result.updates && cs15Result.updates.length > 0 && (
                                <div className="max-h-48 overflow-y-auto border border-gray-200 rounded">
                                    <table className="w-full text-left text-xs">
                                        <thead className="bg-gray-100 text-gray-700">
                                            <tr>
                                                <th className="p-2">Ensamble (A...)</th>
                                                <th className="p-2">SKU (Nivel Máximo)</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {cs15Result.updates.map((u: any, idx: number) => (
                                                <tr key={idx} className="border-t border-gray-100 hover:bg-gray-50">
                                                    <td className="p-2 font-mono font-bold text-blue-700">{u.assembly}</td>
                                                    <td className="p-2 font-mono font-bold text-emerald-700">{u.sku}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    )}
                </Card>
            </div>
        </Card>
    );
};
