import React, { useState, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { ECN, ECNStatus } from '../types';
import * as api from '../services/api';
import { Card, Button, Modal } from './ui';

interface ReportsPageProps {}

const ReportsPage: React.FC<ReportsPageProps> = () => {
    const [ecns, setEcns] = useState<ECN[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showInstructionsModal, setShowInstructionsModal] = useState(false);
    const [copiedKey, setCopiedKey] = useState<string | null>(null);

    const handleCopy = (text: string, key: string) => {
        navigator.clipboard.writeText(text);
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 2500);
    };

    const fetchEcnsForReport = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            // Fetch all ECNs, as reports typically need the full dataset.
            const data = await api.getEcns({ timeFilter: 'Todos' });
            setEcns(data);
        } catch (err) {
            setError("No se pudieron cargar los datos para los reportes.");
            console.error(err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchEcnsForReport();
    }, [fetchEcnsForReport]);
    
    const handleGeneratePendingReport = () => {
        const pendingEcns = ecns.filter(ecn => ecn.status === ECNStatus.Pending);

        if (pendingEcns.length === 0) {
            alert("No hay ECNs pendientes para generar un reporte.");
            return;
        }
        
        const wb = XLSX.utils.book_new();
        const ws_data: any[][] = [];
        const headerMerges: XLSX.Range[] = [];
        let currentRow = 0;

        // --- STYLES ---
        const titleStyle = { 
            font: { sz: 16, bold: true, color: { rgb: "FFFFFFFF" } }, 
            fill: { fgColor: { rgb: "FF003F5C" } },
            alignment: { horizontal: "left", vertical: "center", indent: 1 }
        };
        const subtitleStyle = { 
            font: { sz: 12, bold: true }, 
            alignment: { horizontal: "left", indent: 1 } 
        };
        const generatedStyle = { 
            font: { sz: 10 }, 
            alignment: { horizontal: "left", indent: 1 } 
        };
        const componentHeaderStyle = { 
            font: { bold: true, color: { rgb: "FFFFFFFF" } }, 
            fill: { fgColor: { rgb: "FF003F5C" } }, 
            alignment: { wrapText: true, vertical: "center", horizontal: "center" }, 
            border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } } 
        };
        const dataCellStyle = { 
            font: { sz: 10 }, 
            border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } } 
        };
        const notesCellStyle = { 
            ...dataCellStyle, 
            alignment: { wrapText: true, vertical: "top" } 
        };

        // --- Main Header ---
        ws_data.push([{ v: "Honeywell ECN Manager", s: titleStyle }]);
        headerMerges.push({ s: { r: currentRow, c: 0 }, e: { r: currentRow, c: 7 } });
        currentRow++;
        
        ws_data.push([{ v: "Reporte de ECNs Pendientes", s: subtitleStyle }]);
        headerMerges.push({ s: { r: currentRow, c: 0 }, e: { r: currentRow, c: 7 } });
        currentRow++;

        ws_data.push([{ v: `Generado el ${new Date().toLocaleString('es-ES')}`, s: generatedStyle }]);
        headerMerges.push({ s: { r: currentRow, c: 0 }, e: { r: currentRow, c: 7 } });
        currentRow++;
        
        ws_data.push([]); // Spacer row
        currentRow++;

        // --- Component Table Headers ---
        const componentHeaders = [
            { v: 'ECN', s: componentHeaderStyle },
            { v: 'Fecha Implementación', s: componentHeaderStyle },
            { v: 'Familia', s: componentHeaderStyle },
            { v: 'SKU', s: componentHeaderStyle },
            { v: 'Ensamble', s: componentHeaderStyle },
            { v: 'Componente Viejo', s: componentHeaderStyle },
            { v: 'Componente Nuevo', s: componentHeaderStyle },
            { v: 'Notas', s: componentHeaderStyle }
        ];
        ws_data.push(componentHeaders);
        
        // --- Process each ECN into flat rows ---
        pendingEcns.forEach(ecn => {
            const notesText = ecn.notes.map(note => `(${new Date(note.date).toLocaleString('es-ES')}): ${note.text}`).join('\n');
            
            if (ecn.changes.length > 0) {
                ecn.changes.forEach(change => {
                    const row = [
                        { v: ecn.id, s: dataCellStyle },
                        { v: ecn.implementationDate, s: dataCellStyle },
                        { v: change.family || '—', s: dataCellStyle },
                        { v: change.sku || '—', s: dataCellStyle },
                        { v: change.assembly, s: dataCellStyle },
                        { v: change.oldComponent || change.oldSubassembly || '—', s: dataCellStyle },
                        { v: change.newComponent || change.newSubassembly || '—', s: dataCellStyle },
                        { v: notesText || 'Sin notas.', s: notesCellStyle }
                    ];
                    ws_data.push(row);
                });
            } else {
                // ECN with no component changes
                const row = [
                    { v: ecn.id, s: dataCellStyle },
                    { v: ecn.implementationDate, s: dataCellStyle },
                    { v: 'N/A', s: dataCellStyle },
                    { v: 'N/A', s: dataCellStyle },
                    { v: 'N/A', s: dataCellStyle },
                    { v: 'N/A', s: dataCellStyle },
                    { v: 'N/A', s: dataCellStyle },
                    { v: notesText || 'Sin notas.', s: notesCellStyle }
                ];
                ws_data.push(row);
            }
        });

        const worksheet = XLSX.utils.aoa_to_sheet(ws_data);
        worksheet['!merges'] = headerMerges; // Only apply merges for the main title
        
        // Set row heights
        const rowHeights: XLSX.RowInfo[] = [{ hpt: 25 }, { hpt: 18 }, { hpt: 15 }, { hpt: 5 }, { hpt: 30 }]; // Header rows
        ws_data.forEach((row, rowIndex) => {
            if (rowIndex >= 5) { // Start checking after the headers
                const notesCell = row[7];
                if (notesCell && notesCell.v && typeof notesCell.v === 'string') {
                    const numLines = (notesCell.v.match(/\n/g) || []).length + 1;
                    const height = Math.max(15, 15 * numLines); // min height of 15
                    rowHeights[rowIndex] = { hpt: height };
                }
            }
        });
        worksheet['!rows'] = rowHeights;

        // Column Widths
        worksheet['!cols'] = [
            { wch: 15 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 25 },
            { wch: 25 }, { wch: 25 }, { wch: 80 }
        ];

        // Create workbook and trigger download
        XLSX.utils.book_append_sheet(wb, worksheet, 'ECNs Pendientes');
        XLSX.writeFile(wb, 'Reporte_ECNs_Pendientes.xlsx');
    };

    const handleGenerateCompleteReport = () => {
        if (ecns.length === 0) {
            alert("No hay ECNs para generar un reporte.");
            return;
        }

        const wb = XLSX.utils.book_new();
        const ws_data: any[][] = [];

        // --- STYLES (re-using from the other report for consistency) ---
        const titleStyle = { font: { sz: 16, bold: true, color: { rgb: "FFFFFFFF" } }, fill: { fgColor: { rgb: "FF003F5C" } }, alignment: { horizontal: "left", vertical: "center", indent: 1 } };
        const subtitleStyle = { font: { sz: 12, bold: true }, alignment: { horizontal: "left", indent: 1 } };
        const headerStyle = { font: { bold: true, color: { rgb: "FFFFFFFF" } }, fill: { fgColor: { rgb: "FF003F5C" } }, alignment: { wrapText: true, vertical: "center", horizontal: "center" }, border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } } };
        const dataCellStyle = { font: { sz: 10 }, border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } } };
        const notesCellStyle = { ...dataCellStyle, alignment: { wrapText: true, vertical: "top" } };

        // --- Main Header ---
        ws_data.push([{ v: "Honeywell ECN Manager", s: titleStyle }]);
        ws_data.push([{ v: "Reporte Completo de ECNs", s: subtitleStyle }]);
        ws_data.push([`Generado el ${new Date().toLocaleString('es-ES')}`]);
        ws_data.push([]); // Spacer

        // --- Component Table Headers ---
        const tableHeaders = [
            { v: 'ECN', s: headerStyle },
            { v: 'Estatus', s: headerStyle },
            { v: 'Fecha Implementación', s: headerStyle },
            { v: 'Descripción ECN', s: headerStyle },
            { v: 'Familia', s: headerStyle },
            { v: 'SKU', s: headerStyle },
            { v: 'Ensamble', s: headerStyle },
            { v: 'Componente Viejo', s: headerStyle },
            { v: 'Componente Nuevo', s: headerStyle },
            { v: 'Notas', s: headerStyle }
        ];
        ws_data.push(tableHeaders);

        // --- Process all ECNs into flat rows ---
        ecns.forEach(ecn => {
            const notesText = ecn.notes.map(note => `(${new Date(note.date).toLocaleDateString()}): ${note.text}`).join('\n');
            if (ecn.changes.length > 0) {
                ecn.changes.forEach(change => {
                    ws_data.push([
                        { v: ecn.id, s: dataCellStyle },
                        { v: ecn.status, s: dataCellStyle },
                        { v: ecn.implementationDate, s: dataCellStyle },
                        { v: ecn.description, s: dataCellStyle },
                        { v: change.family || '—', s: dataCellStyle },
                        { v: change.sku || '—', s: dataCellStyle },
                        { v: change.assembly, s: dataCellStyle },
                        { v: change.oldComponent || change.oldSubassembly || '—', s: dataCellStyle },
                        { v: change.newComponent || change.newSubassembly || '—', s: dataCellStyle },
                        { v: notesText || 'Sin notas.', s: notesCellStyle }
                    ]);
                });
            } else {
                ws_data.push([
                    { v: ecn.id, s: dataCellStyle },
                    { v: ecn.status, s: dataCellStyle },
                    { v: ecn.implementationDate, s: dataCellStyle },
                    { v: ecn.description, s: dataCellStyle },
                    { v: 'N/A', s: dataCellStyle },
                    { v: 'N/A', s: dataCellStyle },
                    { v: 'N/A', s: dataCellStyle },
                    { v: 'N/A', s: dataCellStyle },
                    { v: 'N/A', s: dataCellStyle },
                    { v: notesText || 'Sin notas.', s: notesCellStyle }
                ]);
            }
        });

        const worksheet = XLSX.utils.aoa_to_sheet(ws_data);
        
        // Merging header cells
        worksheet['!merges'] = [
            { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } },
            { s: { r: 1, c: 0 }, e: { r: 1, c: 9 } },
            { s: { r: 2, c: 0 }, e: { r: 2, c: 9 } }
        ];
        
        // Column Widths
        worksheet['!cols'] = [
            { wch: 15 }, { wch: 15 }, { wch: 20 }, { wch: 40 }, { wch: 20 },
            { wch: 20 }, { wch: 25 }, { wch: 25 }, { wch: 25 }, { wch: 60 }
        ];

        XLSX.utils.book_append_sheet(wb, worksheet, 'Reporte Completo ECNs');
        XLSX.writeFile(wb, 'Reporte_Completo_ECNs.xlsx');
    };

    if (isLoading) {
        return <p>Cargando datos para reportes...</p>;
    }

    if (error) {
        return <p className="text-red-500">{error}</p>;
    }

    return (
        <div className="space-y-6">
            <h1 className="text-3xl font-bold text-gray-800">Módulo de Reportes</h1>
            <p className="text-gray-600">Genere y descargue reportes personalizados sobre el estado de los ECNs.</p>

            <Card>
                <div className="flex flex-col md:flex-row md:items-center md:justify-between">
                    <div>
                        <h2 className="text-xl font-semibold text-gray-800">Reporte de ECNs Pendientes</h2>
                        <p className="text-sm text-gray-600 mt-2">
                            Exporte un archivo Excel que detalla todos los cambios de componentes para los ECNs que se encuentran en estado "Pendiente".
                            <br/>
                            El reporte tiene un formato profesional, ideal para análisis y reuniones de seguimiento.
                        </p>
                    </div>
                    <div className="mt-4 md:mt-0">
                        <Button variant="primary" onClick={handleGeneratePendingReport}>
                            Generar Reporte Excel
                        </Button>
                    </div>
                </div>
            </Card>

            <Card>
                <div className="flex flex-col md:flex-row md:items-center md:justify-between">
                    <div>
                        <h2 className="text-xl font-semibold text-gray-800">Reporte Completo de ECNs</h2>
                        <p className="text-sm text-gray-600 mt-2">
                            Genere un reporte detallado con todos los ECNs del sistema (pendientes, implementados y cancelados).
                            <br/>
                            Este informe incluye todos los detalles de los componentes, descripciones y notas para un análisis completo.
                        </p>
                    </div>
                    <div className="mt-4 md:mt-0">
                        <Button variant="primary" onClick={handleGenerateCompleteReport}>
                            Generar Reporte Completo
                        </Button>
                    </div>
                </div>
            </Card>

            {/* AUTOMATED SAP SCRIPT INSTRUCTIONS CARD */}
            <Card className="border-indigo-200 bg-gradient-to-r from-indigo-50/50 via-white to-sky-50/40">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="inline-flex items-center justify-center p-1.5 bg-indigo-600 text-white rounded-md text-sm font-bold shadow-sm">
                                ⚡ CMD / Cron
                            </span>
                            <h2 className="text-xl font-semibold text-gray-900">Sincronización SAP Automatizada en Servidor</h2>
                        </div>
                        <p className="text-sm text-gray-600 mt-2">
                            Ejecute la extracción ZPP_CC07, el mapeo automático por defecto y la actualización de la base de datos de manera 100% desatendida sin intervención del usuario (vía Programador de Tareas de Windows o línea de comandos).
                            <br/>
                            Registra automáticamente el historial y auditoría con formato optimizado.
                        </p>
                    </div>
                    <div className="mt-2 md:mt-0 flex-shrink-0">
                        <Button variant="primary" onClick={() => setShowInstructionsModal(true)} className="bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-2">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            Instrucciones de Instalación del Script
                        </Button>
                    </div>
                </div>
            </Card>

            {/* INSTRUCTIONS MODAL */}
            <Modal
                isOpen={showInstructionsModal}
                onClose={() => setShowInstructionsModal(false)}
                title="⚡ Guía de Instalación: Script de Sincronización Automática SAP en Servidor"
                size="full"
            >
                <div className="space-y-6 text-gray-700 text-sm">
                    {/* Intro Banner */}
                    <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
                        <div className="flex items-start gap-3">
                            <span className="text-2xl">🤖</span>
                            <div>
                                <h3 className="font-semibold text-indigo-900 text-base">Ejecución 100% Desatendida sin Intervención Humana</h3>
                                <p className="text-indigo-700 mt-1">
                                    Este script ejecuta la transacción <strong>ZPP_CC07</strong> en SAP GUI, aplica el mapeo automático por defecto, actualiza los ECNs y componentes en la base de datos SQL Server, y genera el registro de auditoría e importación.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Step 1: Files created */}
                    <div className="border border-gray-200 rounded-lg p-4 bg-white space-y-3">
                        <h4 className="font-bold text-gray-900 flex items-center gap-2">
                            <span className="bg-gray-800 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs">1</span>
                            Archivos del Script Generados en el Proyecto
                        </h4>
                        <ul className="list-disc list-inside space-y-1.5 text-gray-600 pl-2">
                            <li>
                                <code className="bg-gray-100 px-2 py-0.5 rounded text-indigo-600 font-mono font-semibold">scripts/standalone-sap-sync.ts</code>
                                <span className="text-xs ml-2 text-gray-500">— Script principal en TypeScript con conexión directa a SAP y BD.</span>
                            </li>
                            <li>
                                <code className="bg-gray-100 px-2 py-0.5 rounded text-indigo-600 font-mono font-semibold">scripts/run-sap-sync.bat</code>
                                <span className="text-xs ml-2 text-gray-500">— Archivo por lotes ejecutable directamente desde el Programador de Tareas de Windows.</span>
                            </li>
                            <li>
                                <code className="bg-gray-100 px-2 py-0.5 rounded text-indigo-600 font-mono font-semibold">npm run sap:sync</code>
                                <span className="text-xs ml-2 text-gray-500">— Comando rápido de NPM para pruebas directas en consola.</span>
                            </li>
                        </ul>
                    </div>

                    {/* Step 2: Manual execution & CLI options */}
                    <div className="border border-gray-200 rounded-lg p-4 bg-white space-y-3">
                        <h4 className="font-bold text-gray-900 flex items-center gap-2">
                            <span className="bg-gray-800 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs">2</span>
                            Comandos de Ejecución por Consola (CMD o PowerShell)
                        </h4>
                        <p className="text-xs text-gray-600">
                            Puedes probar la ejecución inmediata desde una terminal en el servidor:
                        </p>
                        
                        {/* Command 1 */}
                        <div className="bg-gray-900 text-gray-100 rounded-md p-3 flex items-center justify-between font-mono text-xs overflow-x-auto">
                            <span>npm run sap:sync</span>
                            <button
                                onClick={() => handleCopy('npm run sap:sync', 'cmd1')}
                                className="ml-3 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs whitespace-nowrap transition-colors"
                            >
                                {copiedKey === 'cmd1' ? '✓ Copiado' : 'Copiar'}
                            </button>
                        </div>

                        {/* Command 2 with parameters */}
                        <p className="text-xs text-gray-600 mt-2">O pasando parámetros personalizados (Planta, Rango de Fechas):</p>
                        <div className="bg-gray-900 text-gray-100 rounded-md p-3 flex items-center justify-between font-mono text-xs overflow-x-auto">
                            <span>npx tsx scripts/standalone-sap-sync.ts --plant=5205 --startDate=2026-08-21 --endDate=2026-09-30</span>
                            <button
                                onClick={() => handleCopy('npx tsx scripts/standalone-sap-sync.ts --plant=5205 --startDate=2026-08-21 --endDate=2026-09-30', 'cmd2')}
                                className="ml-3 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs whitespace-nowrap transition-colors"
                            >
                                {copiedKey === 'cmd2' ? '✓ Copiado' : 'Copiar'}
                            </button>
                        </div>
                    </div>

                    {/* Step 3: Windows Task Scheduler setup */}
                    <div className="border border-gray-200 rounded-lg p-4 bg-white space-y-3">
                        <h4 className="font-bold text-gray-900 flex items-center gap-2">
                            <span className="bg-gray-800 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs">3</span>
                            Configuración en el Programador de Tareas de Windows (Task Scheduler)
                        </h4>
                        <ol className="list-decimal list-inside space-y-2 text-gray-600 pl-2 text-xs leading-relaxed">
                            <li>
                                Abre el <strong>Programador de tareas</strong> de Windows (<code className="bg-gray-100 px-1 py-0.5 rounded font-mono">taskschd.msc</code>).
                            </li>
                            <li>
                                En el panel derecho, haz clic en <strong>Crear tarea básica...</strong> o <strong>Crear tarea...</strong>.
                            </li>
                            <li>
                                <strong>Nombre:</strong> <code className="bg-gray-100 px-1 py-0.5 rounded font-mono font-semibold">Sincronización Automática SAP ECN</code>.
                            </li>
                            <li>
                                <strong>Desencadenador:</strong> Selecciona <em>Diariamente</em> (ejemplo: <code>06:00 AM</code> o repetir cada 2 horas).
                            </li>
                            <li>
                                <strong>Acción:</strong> Selecciona <em>Iniciar un programa</em>.
                            </li>
                            <li>
                                <strong>Programa o script:</strong> 
                                <div className="bg-gray-900 text-gray-100 rounded-md p-2.5 my-1.5 flex items-center justify-between font-mono text-xs">
                                    <span>cmd.exe</span>
                                    <button
                                        onClick={() => handleCopy('cmd.exe', 'sched_prog')}
                                        className="ml-2 px-2 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs"
                                    >
                                        {copiedKey === 'sched_prog' ? '✓' : 'Copiar'}
                                    </button>
                                </div>
                            </li>
                            <li>
                                <strong>Agregar argumentos (opcional):</strong>
                                <div className="bg-gray-900 text-gray-100 rounded-md p-2.5 my-1.5 flex items-center justify-between font-mono text-xs">
                                    <span>/c "C:\Ruta\Al\Proyecto\scripts\run-sap-sync.bat"</span>
                                    <button
                                        onClick={() => handleCopy('/c "C:\\Ruta\\Al\\Proyecto\\scripts\\run-sap-sync.bat"', 'sched_args')}
                                        className="ml-2 px-2 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs"
                                    >
                                        {copiedKey === 'sched_args' ? '✓' : 'Copiar'}
                                    </button>
                                </div>
                            </li>
                            <li>
                                <strong>Opciones de Seguridad:</strong> Marcar <em>"Ejecutar con los privilegios más altos"</em> y asegurar que la cuenta de servicio de Windows tenga acceso a SAP GUI y a la base de datos SQL Server.
                            </li>
                        </ol>
                    </div>

                    {/* Step 4: Audit log details preview */}
                    <div className="border border-green-200 rounded-lg p-4 bg-green-50/50 space-y-2">
                        <h4 className="font-bold text-green-950 flex items-center gap-2">
                            <span className="bg-green-700 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs">4</span>
                            Registro de Auditoría e Historial Generado
                        </h4>
                        <p className="text-xs text-green-800">
                            Cada ejecución del script por CMD / cron registra automáticamente la auditoría con el formato requerido:
                        </p>
                        <div className="bg-white border border-green-300 rounded p-3 text-xs font-mono text-gray-800 shadow-sm">
                            Importación SAP (Optimizada): SAP_ZPP_CC07_Planta_5205_2026-08-21_a_2026-09-30 Por cmd . 0 nuevos, 5 actualizados (3141ms). ECN NUEVOS Ninguno ECS ACTUALIZADOS 500-101, 500-102, 500-103 )
                        </div>
                        <p className="text-xs text-green-700">
                            Podrás consultar estos registros en la pestaña <strong>Auditoría</strong> y en el historial de importaciones en cualquier momento.
                        </p>
                    </div>

                    {/* Footer Close */}
                    <div className="flex justify-end pt-4 border-t border-gray-200">
                        <Button variant="primary" onClick={() => setShowInstructionsModal(false)}>
                            Entendido y Cerrar
                        </Button>
                    </div>
                </div>
            </Modal>
        </div>
    );
};

export default ReportsPage;