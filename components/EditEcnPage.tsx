
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { ECN, ComponentChange, User, ECNStatus } from '../types';
import * as api from '../services/api';
import { Card, Button, Toast, UserProfile, ConfirmationModal } from './ui';

interface EditEcnPageProps {
    users: User[];
    onDataChange: () => void;
}

const formatDateForDisplay = (dateStr: string | null | undefined): string => {
    if (!dateStr) return '';
    // Assumes date is in YYYY-MM-DD format
    const parts = dateStr.split('T')[0].split('-');
    if (parts.length === 3) {
        return `${parts[0]}-${parts[1]}-${parts[2]}`; // Keep YYYY-MM-DD for input value
    }
    return '';
};

const EditEcnPage: React.FC<EditEcnPageProps> = ({ users, onDataChange }) => {
    const { ecnId } = useParams<{ ecnId: string }>();
    const navigate = useNavigate();

    const [ecn, setEcn] = useState<ECN | null>(null);
    const [originalEcn, setOriginalEcn] = useState<ECN | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
    const [componentSearch, setComponentSearch] = useState('');

    const fetchEcn = useCallback(async () => {
        if (!ecnId) {
            navigate('/');
            return;
        }
        setIsLoading(true);
        setError(null);
        try {
            const ecnData = await api.getEcnById(ecnId);
            setEcn(ecnData);
            setOriginalEcn(JSON.parse(JSON.stringify(ecnData))); // Deep copy for comparison
        } catch (err) {
            console.error("Failed to fetch ECN:", err);
            setError("No se pudo cargar el ECN. Puede que no exista o haya sido eliminado.");
        } finally {
            setIsLoading(false);
        }
    }, [ecnId, navigate]);

    useEffect(() => {
        fetchEcn();
    }, [fetchEcn]);

    const filteredComponents = useMemo(() => {
        if (!ecn) return [];
        if (!componentSearch.trim()) return ecn.changes;
        
        const lowercasedFilter = componentSearch.toLowerCase();
        return ecn.changes.filter(change =>
            (change.assembly?.toLowerCase().includes(lowercasedFilter)) ||
            (change.oldComponent?.toLowerCase().includes(lowercasedFilter)) ||
            (change.newComponent?.toLowerCase().includes(lowercasedFilter)) ||
            (change.sku?.toLowerCase().includes(lowercasedFilter)) ||
            (change.family?.toLowerCase().includes(lowercasedFilter)) ||
            change.relatedSkus?.some(sku => sku.toLowerCase().includes(lowercasedFilter)) ||
            change.relatedFamilies?.some(family => family.toLowerCase().includes(lowercasedFilter))
        );
    }, [ecn, componentSearch]);

    const handleInputChange = (field: keyof ECN, value: any) => {
        if (ecn) {
            setEcn({ ...ecn, [field]: value });
        }
    };
    
    const handleComponentChange = (changeId: string, field: keyof ComponentChange, value: any) => {
        if (ecn) {
            const newChanges = ecn.changes.map(c => {
                if (c.id === changeId) {
                    return { ...c, [field]: value };
                }
                return c;
            });
            setEcn({ ...ecn, changes: newChanges });
        }
    };

    const addComponentChange = () => {
        if (ecn) {
            const newChange: ComponentChange = {
                id: `new-${Date.now()}`,
                assembly: '',
                oldComponent: '',
                newComponent: '',
                sku: '',
                family: '',
                demand: 0,
                onHandInventory: 0,
                openPoQty: 0,
                startDate: new Date().toISOString().split('T')[0],
                site: '5205'
            };
            setEcn({ ...ecn, changes: [...ecn.changes, newChange] });
        }
    };
    
    const removeComponentChange = (changeId: string) => {
        if (ecn) {
            const newChanges = ecn.changes.filter(c => c.id !== changeId);
            setEcn({ ...ecn, changes: newChanges });
        }
    };

    const computeComponentDiff = (originalChanges: ComponentChange[], currentChanges: ComponentChange[]): api.ComponentChangesDiff => {
        const origMap = new Map<string, ComponentChange>(originalChanges.map(c => [c.id, c]));
        const currentIds = new Set<string>(currentChanges.map(c => c.id).filter(id => id && !id.startsWith('new-')));
        
        // Eliminados: IDs originales que ya no están en la lista actual
        const deletedIds = originalChanges.filter(c => !currentIds.has(c.id)).map(c => c.id);

        const added: ComponentChange[] = [];
        const updated: ComponentChange[] = [];

        for (const change of currentChanges) {
            if (!change.id || change.id.startsWith('new-') || !origMap.has(change.id)) {
                added.push(change);
            } else {
                const orig = origMap.get(change.id)!;
                
                const origDate = orig.startDate ? orig.startDate.split('T')[0] : '';
                const currDate = change.startDate ? change.startDate.split('T')[0] : '';

                const isChanged = 
                    (change.assembly || '') !== (orig.assembly || '') ||
                    (change.oldComponent || '') !== (orig.oldComponent || '') ||
                    (change.newComponent || '') !== (orig.newComponent || '') ||
                    (change.sku || '') !== (orig.sku || '') ||
                    (change.family || '') !== (orig.family || '') ||
                    Number(change.demand || 0) !== Number(orig.demand || 0) ||
                    Number(change.onHandInventory || 0) !== Number(orig.onHandInventory || 0) ||
                    Number(change.openPoQty || 0) !== Number(orig.openPoQty || 0) ||
                    currDate !== origDate ||
                    (change.site || '5205') !== (orig.site || '5205') ||
                    (change.assemblyRevision || '') !== (orig.assemblyRevision || '') ||
                    (change.assemblyDescription || '') !== (orig.assemblyDescription || '') ||
                    (change.newComponentRevision || '') !== (orig.newComponentRevision || '') ||
                    (change.newComponentDescription || '') !== (orig.newComponentDescription || '');

                if (isChanged) {
                    updated.push(change);
                }
            }
        }

        return { added, updated, deletedIds };
    };

    const handleSave = async () => {
        if (!ecn) return;
        setIsSaving(true);
        try {
            const diff = originalEcn ? computeComponentDiff(originalEcn.changes || [], ecn.changes || []) : undefined;
            await api.updateEcn(ecn, 'Usuario', diff);
            onDataChange();
    
            let changeSummary = 'ECN guardado correctamente.';
            if (diff) {
                const parts: string[] = [];
                if (diff.updated && diff.updated.length > 0) parts.push(`${diff.updated.length} fila(s) modificada(s)`);
                if (diff.added && diff.added.length > 0) parts.push(`${diff.added.length} agregada(s)`);
                if (diff.deletedIds && diff.deletedIds.length > 0) parts.push(`${diff.deletedIds.length} eliminada(s)`);
                if (parts.length > 0) {
                    changeSummary = `Guardado rápido: ${parts.join(', ')}.`;
                } else {
                    changeSummary = `Guardado: Información general actualizada (sin cambios en componentes).`;
                }
            }

            if (originalEcn && originalEcn.status !== ecn.status) {
                try {
                    await api.sendEcnStatusUpdate(ecn);
                    setNotification({ message: `${changeSummary} Notificación de estado enviada.`, type: 'success' });
                } catch (emailError) {
                    console.error("Failed to send email notification", emailError);
                    setNotification({ message: `${changeSummary} (Falló envío de correo)`, type: 'success' });
                }
            } else {
                setNotification({ message: changeSummary, type: 'success' });
            }
    
            fetchEcn(); // Refetch to get latest data and update originalEcn
        } catch (error) {
            console.error("Failed to save ECN", error);
            if (error instanceof Error && error.message.includes('404')) {
                setNotification({ message: 'No se puede guardar. Este ECN ha sido eliminado por otro usuario.', type: 'error' });
                onDataChange();
                navigate('/');
            } else {
                setNotification({ message: 'Error al guardar el ECN.', type: 'error' });
            }
        } finally {
            setIsSaving(false);
        }
    };

    const handleExportToExcel = () => {
        if (!ecn || filteredComponents.length === 0) {
            setNotification({ message: 'No hay componentes para exportar.', type: 'error'});
            return;
        }
        const dataToExport = filteredComponents.map(c => ({
            'ENSAMBLE': c.assembly,
            'COMP. VIEJO': c.oldComponent,
            'COMP. NUEVO': c.newComponent,
            'SKU': c.sku || '',
            'FAMILIA': c.family || '',
            'SKUS ASOCIADOS POR SMD': c.relatedProducts?.map(product => product.sku).join(', ') || '',
            'FAMILIAS ASOCIADAS POR SMD': [...new Set(c.relatedProducts?.map(product => product.family) || [])].join(', '),
            'FECHA INICIO': c.startDate ? c.startDate.split('T')[0] : ''
        }));
        const worksheet = XLSX.utils.json_to_sheet(dataToExport);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Componentes');
        XLSX.writeFile(workbook, `ECN_${ecn.id}_Componentes.xlsx`);
    };
    

    if (isLoading) {
        return <div className="text-center p-8">Cargando ECN...</div>;
    }

    if (error) {
        return (
            <Card className="text-center py-8">
                <h2 className="text-xl font-bold text-destructive">Error</h2>
                <p className="text-muted-foreground mt-2 mb-4">{error}</p>
                <Button onClick={() => navigate('/')}>Volver al Dashboard</Button>
            </Card>
        );
    }
    
    if (!ecn) return null;
    
    const inputClass = "block w-full p-2 border border-border rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-ring bg-input text-foreground text-sm";
    const labelClass = "block text-sm font-medium text-foreground mb-1";
    
    return (
        <div className="space-y-6">
            {notification && <Toast message={notification.message} type={notification.type} onClose={() => setNotification(null)} />}
            
            <div className="flex justify-between items-center">
                <h1 className="text-3xl font-bold text-foreground">Editar ECN: {ecn.id}</h1>
                 <div className="flex items-center gap-2">
                    <Button variant="secondary" onClick={handleExportToExcel}>Exportar a Excel</Button>
                    <Button variant="secondary" onClick={() => alert('Importar desde Excel no está implementado en esta página.')}>Importar desde Excel</Button>
                    <Button variant="secondary" onClick={() => navigate(-1)}>Cancelar</Button>
                    <Button variant="primary" onClick={handleSave} disabled={isSaving}>
                        {isSaving ? 'Guardando...' : 'Guardar Cambios'}
                    </Button>
                </div>
            </div>

            <Card>
                <h2 className="text-xl font-semibold text-foreground mb-6">Información General</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-4">
                     <div>
                        <label htmlFor="initiator" className={labelClass}>Iniciador</label>
                        <select
                            id="initiator"
                            value={ecn.initiator}
                            onChange={e => handleInputChange('initiator', e.target.value)}
                            className={inputClass}
                        >
                            {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.id})</option>)}
                        </select>
                    </div>
                     <div>
                        <label htmlFor="status" className={labelClass}>Estatus</label>
                         <select
                            id="status"
                            value={ecn.status}
                            onChange={e => handleInputChange('status', e.target.value as ECNStatus)}
                            className={inputClass}
                        >
                            {Object.values(ECNStatus).map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                    </div>
                     <div>
                        <label htmlFor="creationDate" className={labelClass}>Fecha de Creación</label>
                        <input
                            id="creationDate"
                            type="text"
                            readOnly
                            value={formatDateForDisplay(ecn.creationDate)}
                            className={`${inputClass} bg-muted cursor-not-allowed`}
                        />
                    </div>
                </div>
                <div>
                    <label htmlFor="description" className={labelClass}>Descripción del cambio</label>
                    <textarea
                        id="description"
                        rows={5}
                        value={ecn.description}
                        onChange={e => handleInputChange('description', e.target.value)}
                        className={inputClass}
                    />
                </div>
            </Card>

            <Card>
                <div className="flex flex-col md:flex-row justify-between md:items-center mb-4 gap-4">
                    <h2 className="text-xl font-semibold text-foreground">Componentes Afectados ({ecn.changes.length})</h2>
                    <div className="flex items-center gap-4">
                         <input
                            type="text"
                            placeholder="Buscar por Ensamble, Comp. Viejo/Nuevo, SKU o Familia..."
                            value={componentSearch}
                            onChange={e => setComponentSearch(e.target.value)}
                            className="w-full md:w-80 px-3 py-2 border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-ring text-sm bg-input text-foreground"
                        />
                        <Button onClick={addComponentChange}>Agregar Componente</Button>
                    </div>
                </div>
                <div className="overflow-x-auto border rounded-lg">
                    <table className="min-w-full divide-y divide-border">
                        <thead className="bg-muted">
                            <tr>
                                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Ensamble</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Comp. Viejo</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Comp. Nuevo</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Sitio</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">SKU</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Familia</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Fecha Inicio</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Acciones</th>
                            </tr>
                        </thead>
                        <tbody className="bg-card divide-y divide-border">
                            {filteredComponents.map((change) => (
                                <tr key={change.id}>
                                    <td className="px-2 py-2"><input value={change.assembly} onChange={e => handleComponentChange(change.id, 'assembly', e.target.value)} className={inputClass} /></td>
                                    <td className="px-2 py-2"><input value={change.oldComponent} onChange={e => handleComponentChange(change.id, 'oldComponent', e.target.value)} className={inputClass} /></td>
                                    <td className="px-2 py-2"><input value={change.newComponent} onChange={e => handleComponentChange(change.id, 'newComponent', e.target.value)} className={inputClass} /></td>
                                    <td className="px-2 py-2">
                                        <select 
                                            value={change.site || '5205'} 
                                            onChange={e => handleComponentChange(change.id, 'site', e.target.value)}
                                            className={`${inputClass} w-24`}
                                        >
                                            <option value="5205">5205</option>
                                            <option value="5382">5382</option>
                                            <option value="4438">4438</option>
                                            <option value="5731">5731</option>
                                        </select>
                                    </td>
                                    <td className="px-2 py-2">
                                        <input value={change.sku || ''} onChange={e => handleComponentChange(change.id, 'sku', e.target.value)} className={`${inputClass} w-28`} />
                                        {!!change.relatedProducts?.length && <p className="mt-1 text-xs text-muted-foreground max-w-xs">Por SMD: {change.relatedProducts.map(product => product.sku).join(', ')}</p>}
                                    </td>
                                    <td className="px-2 py-2">
                                        <input value={change.family || ''} onChange={e => handleComponentChange(change.id, 'family', e.target.value)} className={`${inputClass} w-28`} />
                                        {!!change.relatedProducts?.length && <p className="mt-1 text-xs text-muted-foreground">Por SMD: {[...new Set(change.relatedProducts.map(product => product.family))].join(', ')}</p>}
                                    </td>
                                    <td className="px-2 py-2"><input type="date" value={formatDateForDisplay(change.startDate)} onChange={e => handleComponentChange(change.id, 'startDate', e.target.value)} className={inputClass} /></td>
                                    <td className="px-2 py-2">
                                        <Button variant="danger" onClick={() => removeComponentChange(change.id)}>Eliminar</Button>
                                    </td>
                                </tr>
                            ))}
                            {filteredComponents.length === 0 && (
                                <tr>
                                    <td colSpan={8} className="text-center py-4 text-muted-foreground">
                                        {componentSearch ? 'No hay componentes que coincidan con la búsqueda.' : 'No hay cambios de componentes para este ECN.'}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </Card>
        </div>
    );
};

export default EditEcnPage;
