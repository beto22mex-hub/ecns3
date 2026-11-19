import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { ECN, ChecklistItem, ActionStatus, User } from '../types';
import * as api from '../services/api';
import { Card, Button, UserProfile, Toast } from './ui';

interface ChecklistPageProps {
    users: User[];
}

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

const ChecklistPage: React.FC<ChecklistPageProps> = ({ users }) => {
    const { ecnId } = useParams<{ ecnId: string }>();
    const navigate = useNavigate();

    const [ecn, setEcn] = useState<ECN | null>(null);
    const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
    const [isSaving, setIsSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' } | null>(null);

    const userMap = useMemo(() => new Map(users.map(user => [user.id, user])), [users]);

    useEffect(() => {
        if (!ecnId) {
            navigate('/');
            return;
        }

        const fetchEcn = async () => {
            try {
                setIsLoading(true);
                const ecnData = await api.getEcnById(ecnId);
                setEcn(ecnData);
                // Deep copy to prevent direct state mutation
                setChecklist(JSON.parse(JSON.stringify(ecnData.checklist)));
                setError(null);
            } catch (err) {
                console.error("Failed to fetch ECN:", err);
                setError((err as Error).message || "No se pudo cargar el ECN. Puede que no exista o haya un problema con el servidor.");
            } finally {
                setIsLoading(false);
            }
        };

        fetchEcn();
    }, [ecnId, navigate]);

    const handleChecklistChange = (itemId: string, field: keyof ChecklistItem, value: string) => {
        setChecklist(prev =>
            prev.map(item =>
                item.id === itemId ? { ...item, [field]: value } : item
            )
        );
    };

    const handleSave = async () => {
        if (!ecn) return;
        setIsSaving(true);
        try {
            await api.updateChecklist(ecn.id, checklist, 'CurrentUser');
            setNotification({ message: 'Checklist guardado correctamente.', type: 'success' });
        } catch (error) {
            console.error("Failed to save checklist", error);
            if (error instanceof Error && error.message.includes('404')) {
                setNotification({ message: 'No se puede guardar. Este ECN ha sido eliminado por otro usuario.', type: 'error' });
                navigate('/'); // Redirect to safety
            } else {
                setNotification({ message: 'Error al guardar el checklist.', type: 'error' });
            }
        } finally {
            setIsSaving(false);
        }
    };
    
    const handleExport = () => {
        if (!ecn) return;

        const wb = XLSX.utils.book_new();
        const ws_data: any[][] = [];

        // --- Define Styles ---
        const headerStyle = { font: { bold: true, sz: 11 }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, fill: { fgColor: { rgb: "FFDDEBF7" } }, border: { top: {style:"thin"}, bottom:{style:"thin"}, left:{style:"thin"}, right:{style:"thin"} } };
        const labelStyle = { font: { bold: true } };
        const questionStyle = { fill: { fgColor: { rgb: "FFFFFF00" } }, border: { left:{style:"thin"}, right:{style:"thin"} } }; // Yellow
        const departmentStyle = { fill: { fgColor: { rgb: "FFC6E0B4" } }, border: { left:{style:"thin"}, right:{style:"thin"} } }; // Green
        const defaultCellStyle = { border: { left:{style:"thin"}, right:{style:"thin"} } };
        const bottomBorderStyle = { border: { bottom: {style:"thin"}, left:{style:"thin"}, right:{style:"thin"} } };

        // --- ECN Header Information ---
        const productFamily = ecn.changes?.find(c => c.family)?.family || 'N/A';
        ws_data.push([{ v: 'ECN No.:', s: labelStyle }, ecn.id]);
        ws_data.push([{ v: 'Descripción ECN:', s: labelStyle }, ecn.description || 'Sin descripción']);
        ws_data.push([{ v: 'Product Family:', s: labelStyle }, productFamily]);
        ws_data.push([{ v: 'Close date:', s: labelStyle }, ecn.implementationDate]);
        ws_data.push([]);

        // --- Main Checklist Headers ---
        const mainHeader = ["Pregunta", "Departamento", "Estado", "Comentario/Acción", "Quién?", "Cuándo?", "CRB", "CRB-OK?", "CIB", "CIB-OK?", "ISC Impl.", "Impl. OK?"];
        ws_data.push(mainHeader.map(h => ({ v: h, s: headerStyle })));

        // --- Checklist Data Rows ---
        checklist.forEach((item, index) => {
             const isLastItem = index === checklist.length - 1;
             const cellStyle = isLastItem ? bottomBorderStyle : defaultCellStyle;
             const qStyle = { ...questionStyle, ...(isLastItem ? bottomBorderStyle : defaultCellStyle) };
             const dStyle = { ...departmentStyle, ...(isLastItem ? bottomBorderStyle : defaultCellStyle) };

             ws_data.push([
                { v: item.question, s: qStyle },
                { v: item.department, s: dStyle },
                { v: item.actionStatus, s: cellStyle },
                { v: item.comment, s: cellStyle },
                { v: item.who, s: cellStyle },
                { v: item.when, s: cellStyle },
                { v: item.crb, s: cellStyle },
                { v: item.crbOk, s: cellStyle },
                { v: item.cib, s: cellStyle },
                { v: item.cibOk, s: cellStyle },
                { v: item.iscImpl, s: cellStyle },
                { v: item.implOk, s: cellStyle }
             ]);
        });

        const ws = XLSX.utils.aoa_to_sheet(ws_data);
        
        // --- Column Widths ---
        ws['!cols'] = [
            { wch: 70 }, { wch: 25 }, { wch: 15 }, { wch: 30 }, { wch: 15 }, { wch: 15 },
            { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 20 }
        ];

        // --- Create and Download Workbook ---
        XLSX.utils.book_append_sheet(wb, ws, `Checklist ECN ${ecn.id}`);
        XLSX.writeFile(wb, `ECN_${ecn.id}_Checklist.xlsx`);
    };

    const handleExportCsv = () => {
        if (!ecn) return;
        const dataToExport = checklist.map(item => ({
            'Pregunta': item.question,
            'Departamento': item.department,
            'Estado': item.actionStatus,
            'Comentario/Acción': item.comment,
            'Quién?': item.who,
            'Cuándo?': item.when,
            'CRB': item.crb,
            'CRB-OK?': item.crbOk,
            'CIB': item.cib,
            'CIB-OK?': item.cibOk,
            'ISC Impl.': item.iscImpl,
            'Impl. OK?': item.implOk,
        }));
        exportToCsv(`ECN_${ecn.id}_Checklist.csv`, dataToExport);
    };

    const groupedChecklist = useMemo(() => {
        if (!checklist) return [];
        return checklist.reduce((acc, item) => {
            let section = acc.find(s => s.name === item.department);
            if (!section) {
                section = { name: item.department, items: [] };
                acc.push(section);
            }
            section.items.push(item);
            return acc;
        }, [] as { name: string; items: ChecklistItem[] }[]);
    }, [checklist]);
    
    const departmentColors: Record<string, string> = {
        "AME: Product engineering": "bg-yellow-100",
        "Material Planning": "bg-yellow-100",
        "Strategic / Tactical buyer": "bg-pink-100",
        "AME: Process engineering": "bg-blue-100",
        "AME: Quality engineering": "bg-blue-100",
        "Warehouse": "bg-gray-100",
        "Finance": "bg-purple-100",
        "HSE": "bg-red-100",
    };
    
    const inputStyle = "w-full p-1 border border-gray-300 rounded-md focus:border-brand-red focus:ring-1 focus:ring-brand-red bg-gray-100 text-gray-900";


    if (isLoading) {
        return <div className="text-center p-8">Cargando checklist...</div>;
    }
    
    if (error) {
        return (
            <Card className="text-center py-8">
                <h2 className="text-xl font-bold text-red-600">Error</h2>
                <p className="text-gray-600 mt-2 mb-4">{error}</p>
                <Button onClick={() => navigate('/changes')}>Volver a la lista</Button>
            </Card>
        );
    }

    if (!ecn) {
        return <p>ECN no encontrado.</p>;
    }

    const initiator = userMap.get(ecn.initiator);

    return (
        <div className="space-y-6">
            {notification && <Toast message={notification.message} type={notification.type} onClose={() => setNotification(null)} />}
            <div className="flex justify-between items-center">
                <div>
                    <h1 className="text-3xl font-bold text-gray-800">Checklist ECN: {ecn.id}</h1>
                    <div className="mt-1">
                        {initiator ? (
                            <UserProfile user={initiator} />
                        ) : (
                            <p className="text-gray-600">Iniciador: {ecn.initiator}</p>
                        )}
                    </div>
                </div>
                <div className="flex gap-2">
                    <Button onClick={handleSave} variant="primary" disabled={isSaving}>
                        {isSaving ? 'Guardando...' : 'Guardar Cambios'}
                    </Button>
                    <Button onClick={handleExportCsv} variant="secondary">Exportar a CSV</Button>
                    <Button onClick={handleExport} variant="secondary">Exportar a Excel</Button>
                </div>
            </div>

            {groupedChecklist.map(section => (
                <Card key={section.name} className={`${departmentColors[section.name] || 'bg-white'}`}>
                    <h2 className="text-xl font-semibold text-gray-800 mb-4">{section.name}</h2>
                    <div className="overflow-x-auto">
                        <table className="min-w-full text-sm">
                            <thead className="bg-gray-200">
                                <tr>
                                    <th className="p-2 text-left w-1/4 text-gray-700">Pregunta</th>
                                    <th className="p-2 text-left text-gray-700">Estado</th>
                                    <th className="p-2 text-left text-gray-700">Comentario</th>
                                    <th className="p-2 text-left text-gray-700">Quién?</th>
                                    <th className="p-2 text-left text-gray-700">Cuándo?</th>
                                    <th className="p-2 text-left text-gray-700">CRB</th>
                                    <th className="p-2 text-left text-gray-700">CRB OK?</th>
                                    <th className="p-2 text-left text-gray-700">CIB</th>
                                    <th className="p-2 text-left text-gray-700">CIB OK?</th>
                                    <th className="p-2 text-left text-gray-700">ISC Impl.</th>
                                    <th className="p-2 text-left text-gray-700">Impl. OK?</th>
                                </tr>
                            </thead>
                            <tbody>
                                {section.items.map(item => (
                                    <tr key={item.id} className="border-b border-gray-200 bg-white">
                                        <td className="p-2 font-medium text-gray-800">{item.question}</td>
                                        <td className="p-2">
                                            <select value={item.actionStatus} onChange={e => handleChecklistChange(item.id, 'actionStatus', e.target.value)} className={inputStyle}>
                                                <option value="">Seleccionar...</option>
                                                {Object.values(ActionStatus).map(s => <option key={s} value={s}>{s}</option>)}
                                            </select>
                                        </td>
                                        <td className="p-2"><input type="text" value={item.comment} onChange={e => handleChecklistChange(item.id, 'comment', e.target.value)} className={inputStyle}/></td>
                                        <td className="p-2"><input type="text" value={item.who} onChange={e => handleChecklistChange(item.id, 'who', e.target.value)} className={`${inputStyle} w-24`}/></td>
                                        <td className="p-2"><input type="date" value={item.when} onChange={e => handleChecklistChange(item.id, 'when', e.target.value)} className={inputStyle}/></td>
                                        <td className="p-2"><input type="text" value={item.crb} onChange={e => handleChecklistChange(item.id, 'crb', e.target.value)} className={`${inputStyle} w-20`}/></td>
                                        <td className="p-2"><input type="text" value={item.crbOk} onChange={e => handleChecklistChange(item.id, 'crbOk', e.target.value)} className={`${inputStyle} w-20`}/></td>
                                        <td className="p-2"><input type="text" value={item.cib} onChange={e => handleChecklistChange(item.id, 'cib', e.target.value)} className={`${inputStyle} w-20`}/></td>
                                        <td className="p-2"><input type="text" value={item.cibOk} onChange={e => handleChecklistChange(item.id, 'cibOk', e.target.value)} className={`${inputStyle} w-20`}/></td>
                                        <td className="p-2"><input type="text" value={item.iscImpl} onChange={e => handleChecklistChange(item.id, 'iscImpl', e.target.value)} className={`${inputStyle} w-20`}/></td>
                                        <td className="p-2"><input type="text" value={item.implOk} onChange={e => handleChecklistChange(item.id, 'implOk', e.target.value)} className={`${inputStyle} w-20`}/></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Card>
            ))}
        </div>
    );
};

export default ChecklistPage;