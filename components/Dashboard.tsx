import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid, PieChart, Pie, Cell } from 'recharts';
import { ECN, ECNStatus, ComponentChange, ECNNote, AuditLogEntry, User } from '../types';
import { Card, Button, Modal, StatusBadge, Pagination, UserProfile, Toast } from './ui';
import * as api from '../services/api';
import { useTheme } from './ThemeContext';

// --- Type definition for sortable columns ---
type SortableKeys = keyof Pick<ECN, 'id' | 'initiator' | 'description' | 'status' | 'implementationDate' | 'familyList'> | 'daysRemaining';
type GroupingKey = 'family' | 'sku' | 'assembly' | 'none';

// --- Helper Functions ---
const LoadingIndicator: React.FC<{ message?: string }> = ({ message = 'Cargando datos...' }) => (
    <div role="status" aria-live="polite" className="flex items-center justify-center gap-3 px-5 py-8 text-sm text-muted-foreground">
        <span aria-hidden="true" className="h-6 w-6 shrink-0 animate-spin rounded-full border-[3px] border-primary/20 border-t-primary" />
        <div><p className="font-semibold text-foreground">{message}</p><p className="mt-0.5 text-xs">Por favor espere un momento.</p></div>
    </div>
);

/**
 * Formats a date string from the API (expected to be ISO 8601 format) into 'YYYY-MM-DD'.
 * It's designed to be fast and reliable for the specific format returned by the backend.
 * @param dateInput The date string from the API.
 * @returns A formatted date string 'YYYY-MM-DD' or 'N/A' if the input is invalid.
 */
const formatDate = (dateInput: string | null | undefined): string => {
    // Return 'N/A' for any falsy input (null, undefined, empty string).
    if (!dateInput || dateInput.startsWith('0001') || dateInput.startsWith('1900')) {
        return 'N/A';
    }
    
    // The backend provides ISO 8601 strings (e.g., "2025-10-28T00:00:00.000Z").
    // The most reliable way to get the date part is to take the first 10 characters.
    // This avoids issues with `split` if the format slightly changes.
    const datePart = dateInput.substring(0, 10);
    
    // Validate that the extracted part is in a plausible YYYY-MM-DD format.
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
        return datePart;
    }
    
    // If the format is unexpected, return N/A to prevent displaying incorrect data.
    return 'N/A';
};

/**
 * Calculates the number of days remaining until the implementation date.
 * Relies on the standard `new Date()` constructor which correctly parses ISO strings.
 * @param dateStr The date string from the API.
 * @returns The number of days remaining. Returns Infinity for invalid dates for sorting.
 */
const calculateDaysRemaining = (dateStr: string | null | undefined): number => {
    if (!dateStr) {
        return Infinity;
    }

    const implementationDate = new Date(dateStr);
    if (isNaN(implementationDate.getTime())) {
        return Infinity; // Invalid date string
    }

    const today = new Date();
    // Get today's date at UTC midnight for a fair, timezone-agnostic comparison.
    const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

    // Also get the implementation date at UTC midnight.
    const implementationDateUTC = new Date(Date.UTC(implementationDate.getUTCFullYear(), implementationDate.getUTCMonth(), implementationDate.getUTCDate()));

    const diffTime = implementationDateUTC.getTime() - todayUTC.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    return diffDays;
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

// --- Modals defined outside the main component to prevent re-creation on render ---
interface DescriptionModalProps {
    isOpen: boolean;
    onClose: () => void;
    description: string;
    title: string;
}

const DescriptionModal: React.FC<DescriptionModalProps> = ({ isOpen, onClose, description, title }) => {
    if (!isOpen) return null;
    return (
        <Modal isOpen={isOpen} onClose={onClose} title={title} size="lg">
            <p className="text-muted-foreground whitespace-pre-wrap">{description}</p>
            <div className="mt-6 flex justify-end">
                <Button onClick={onClose}>Cerrar</Button>
            </div>
        </Modal>
    );
};


interface EcnDetailModalProps {
    ecn: ECN | null;
    isOpen: boolean;
    onClose: () => void;
    onRegenerateSummary?: (ecnId: string) => Promise<void>;
    isGeneratingSummary?: boolean;
}

const EcnDetailModal: React.FC<EcnDetailModalProps> = ({ ecn, isOpen, onClose, onRegenerateSummary, isGeneratingSummary }) => {
    const [isMaximized, setIsMaximized] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [grouping, setGrouping] = useState<GroupingKey>('none');
    const [startDateFilter, setStartDateFilter] = useState('');
    const [endDateFilter, setEndDateFilter] = useState('');
    
    useEffect(() => {
        // Reset state when modal is closed or ecn changes
        if (!isOpen) {
            setIsMaximized(false);
            setSearchTerm('');
            setGrouping('none');
            setStartDateFilter('');
            setEndDateFilter('');
        }
    }, [isOpen]);

    const filteredChanges = useMemo(() => {
        if (!ecn) return [];
        if (!searchTerm.trim()) {
            return ecn.changes;
        }
        const lowercasedFilter = searchTerm.toLowerCase();
        return ecn.changes.filter(change =>
            (change.oldComponent?.toLowerCase().includes(lowercasedFilter)) ||
            (change.newComponent?.toLowerCase().includes(lowercasedFilter)) ||
            change.relatedSkus?.some(sku => sku.toLowerCase().includes(lowercasedFilter)) ||
            change.relatedFamilies?.some(family => family.toLowerCase().includes(lowercasedFilter))
        );
    }, [ecn, searchTerm]);
    
    const filteredNotes = useMemo(() => {
        if (!ecn) return [];
        let notes = ecn.notes.slice().reverse(); // Show newest first
        if (startDateFilter) {
            const filterStart = new Date(startDateFilter).toISOString().split('T')[0];
            notes = notes.filter(note => new Date(note.date).toISOString().split('T')[0] >= filterStart);
        }
        if (endDateFilter) {
            const filterEnd = new Date(endDateFilter).toISOString().split('T')[0];
            notes = notes.filter(note => new Date(note.date).toISOString().split('T')[0] <= filterEnd);
        }
        return notes;
    }, [ecn, startDateFilter, endDateFilter]);

    const groupedAndSortedChanges = useMemo(() => {
        if (grouping === 'none') {
            return filteredChanges.slice().sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
        }

        const grouped = filteredChanges.reduce((acc, change) => {
            const key = String(change[grouping as keyof ComponentChange] || 'Sin ' + grouping);
            if (!acc[key as string]) {
                (acc as any)[key] = [];
            }
            (acc as any)[key].push(change);
            return acc;
        }, {} as Record<string, ComponentChange[]>);

        // Sort each group internally
        Object.keys(grouped).forEach(key => {
            grouped[key].sort((a, b) => {
                if (grouping === 'assembly') {
                    const skuCompare = (a.sku || '').localeCompare(b.sku || '');
                    if (skuCompare !== 0) return skuCompare;
                }
                return new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
            });
        });

        return grouped;
    }, [filteredChanges, grouping]);

    if (!ecn) return null;

    const handleExportDetailsCsv = () => {
        if (!ecn) return;
        const dataToExport = filteredChanges.map(change => ({
            'Familia': change.family || '—',
            'SKU': change.sku || '—',
            'SKUs asociados por SMD': change.relatedProducts?.map(product => product.sku).join(', ') || '',
            'Familias asociadas por SMD': [...new Set(change.relatedProducts?.map(product => product.family) || [])].join(', '),
            'Sitio': change.site || '—',
            'Ensamble': change.assembly,
            'Subensamble Viejo': change.oldSubassembly || '—',
            'Componente Viejo': change.oldComponent || '—',
            'Subensamble Nuevo': change.newSubassembly || '—',
            'Componente Nuevo': change.newComponent || '—',
            'Fecha Inicio': formatDate(change.startDate),
            'Demand': change.demand,
            'On Hand Inventory': change.onHandInventory,
            'Open PO Qty': change.openPoQty,
        }));
        exportToCsv(`ecn_${ecn.id}_details.csv`, dataToExport);
    };
    
    const modalInputStyle = "px-2 py-1 border border-input rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-ring bg-input text-foreground";

    const renderTableContent = () => {
        const headers = ['Ensamble', 'Sitio', 'Componente viejo', 'Componente nuevo', 'SKU', 'Familia', 'Demanda', 'Inventario nuevo comp.', 'Cantidad en POs', 'Fecha inicio', 'Estatus'];
        // Ordenar por fecha de inicio descendente
        const sortedChanges = Array.isArray(groupedAndSortedChanges)
            ? groupedAndSortedChanges.slice().sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime())
            : [];
        const today = new Date();
        today.setHours(0,0,0,0); // Solo comparar fecha, no hora
        const isPastOrToday = (dateStr: string | undefined) => {
            if (!dateStr) return false;
            const d = new Date(dateStr);
            d.setHours(0,0,0,0);
            return d.getTime() <= today.getTime();
        };
        const renderRow = (change: ComponentChange, index: number) => (
            <tr key={`${change.id}-${index}`}
                className={isPastOrToday(change.startDate) ? 'bg-green-200 dark:bg-green-900/40' : ''}>
                <td className="px-4 py-2 whitespace-nowrap text-sm font-medium text-foreground">{change.assembly}</td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-muted-foreground">{change.site || '—'}</td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-muted-foreground">{change.oldSubassembly || change.oldComponent || '—'}</td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-muted-foreground">{change.newSubassembly || change.newComponent || '—'}</td>
                <td className="px-4 py-2 text-sm text-muted-foreground">
                    {change.sku || '—'}
                    {!!change.relatedProducts?.length && <p className="mt-1 text-xs max-w-xs">Por SMD: {change.relatedProducts.map(product => product.sku).join(', ')}</p>}
                </td>
                <td className="px-4 py-2 text-sm text-muted-foreground">
                    {change.family || '—'}
                    {!!change.relatedProducts?.length && <p className="mt-1 text-xs">Por SMD: {[...new Set(change.relatedProducts.map(product => product.family))].join(', ')}</p>}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-muted-foreground">{change.demand}</td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-muted-foreground">{change.onHandInventory}</td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-muted-foreground">{change.openPoQty}</td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-muted-foreground">{formatDate(change.startDate)}</td>
                <td className="px-4 py-2 whitespace-nowrap text-sm">
                    {isPastOrToday(change.startDate) ? (
                        <span className="text-green-700 dark:text-green-400 font-medium">Implementado</span>
                    ) : (
                        <span className="text-yellow-600 dark:text-yellow-400 font-medium">Pendiente</span>
                    )}
                </td>
            </tr>
        );

        return (
            <table className="min-w-full divide-y divide-border">
                <thead className="bg-muted/50 sticky top-0">
                    <tr>
                        {headers.map((header, index) => (
                            <th key={index} scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                {header}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="bg-card divide-y divide-border">
                    {Array.isArray(groupedAndSortedChanges) ? 
                        sortedChanges.map(renderRow) :
                        Object.entries(groupedAndSortedChanges as Record<string, ComponentChange[]>).map(([groupName, items]) => (
                            <React.Fragment key={groupName}>
                                <tr>
                                    <td colSpan={headers.length} className="px-4 py-2 bg-muted text-sm font-bold text-foreground">
                                        {groupName} ({items.length})
                                    </td>
                                </tr>
                                {items.slice().sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime()).map(renderRow)}
                            </React.Fragment>
                        ))
                    }
                    {filteredChanges.length === 0 && (
                         <tr>
                            <td colSpan={headers.length} className="text-center py-4 text-muted-foreground">No hay componentes que coincidan con la búsqueda.</td>
                        </tr>
                    )}
                </tbody>
            </table>
        );
    }

    if (ecn.id === 'loading') return <Modal isOpen={isOpen} onClose={onClose} title="Detalle del ECN" size="full"><LoadingIndicator message="Cargando detalle del ECN..." /></Modal>;

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={`Detalle ECN ${ecn.id}`} size={isMaximized ? 'screen' : 'full'}>
            <div className="space-y-4">
                 <div className="flex justify-between items-center">
                    <div>
                        <strong>Estatus:</strong> <StatusBadge status={ecn.status} />
                    </div>
                    <div className="flex items-center space-x-2">
                        <input
                            type="text"
                            placeholder="Buscar por número de parte..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className={`w-64 ${modalInputStyle}`}
                        />
                        <select
                            value={grouping}
                            onChange={(e) => setGrouping(e.target.value as GroupingKey)}
                            className={modalInputStyle}
                        >
                            <option value="none">Sin agrupar</option>
                            <option value="family">Agrupar por Familia</option>
                            <option value="sku">Agrupar por SKU</option>
                            <option value="assembly">Agrupar por Ensamble</option>
                        </select>
                         <Button onClick={() => setIsMaximized(!isMaximized)} variant="secondary">
                            {isMaximized ? 'Restaurar' : 'Maximizar'}
                        </Button>
                    </div>
                </div>
                
                {ecn.summary ? (
                    <div className="p-4 bg-muted/40 border border-border rounded-lg">
                        <div className="flex justify-between items-center mb-1">
                            <h4 className="text-sm font-bold text-foreground uppercase tracking-wider flex items-center gap-2">
                                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500"></span>
                                Resumen del cambio (Español)
                            </h4>
                            {onRegenerateSummary && (
                                <button
                                    onClick={() => onRegenerateSummary(ecn.id)}
                                    disabled={isGeneratingSummary}
                                    className="text-xs text-primary hover:underline font-medium disabled:opacity-50 flex items-center gap-1 cursor-pointer"
                                    title="Volver a generar el resumen con IA obligatoriamente en español"
                                >
                                    {isGeneratingSummary ? 'Regenerando en español...' : '↻ Regenerar en español'}
                                </button>
                            )}
                        </div>
                        <p className="text-sm text-foreground/90 leading-relaxed italic">
                            "{ecn.summary}"
                        </p>
                    </div>
                ) : (
                    <div className="p-3 bg-muted/20 border border-dashed border-border rounded-lg flex justify-between items-center">
                        <span className="text-xs text-muted-foreground">Este ECN aún no cuenta con un resumen ejecutivo generado.</span>
                        {onRegenerateSummary && (
                            <Button 
                                onClick={() => onRegenerateSummary(ecn.id)} 
                                disabled={isGeneratingSummary}
                            >
                                {isGeneratingSummary ? 'Generando en español...' : 'Generar resumen en español (IA)'}
                            </Button>
                        )}
                    </div>
                )}

                <div className="overflow-auto border rounded-lg" style={{ maxHeight: '50vh' }}>
                    {renderTableContent()}
                </div>

                <div>
                    <div className="flex justify-between items-center mt-6 border-t pt-4 border-border">
                        <h3 className="text-lg font-medium text-foreground">Notas de archivo ({filteredNotes.length})</h3>
                        <div className="flex items-center space-x-2">
                             <label className="text-sm font-medium text-foreground">Filtrar:</label>
                             <input
                                type="date"
                                value={startDateFilter}
                                onChange={e => setStartDateFilter(e.target.value)}
                                className={`w-auto ${modalInputStyle}`}
                             />
                             <span className="text-muted-foreground">-</span>
                             <input
                                type="date"
                                value={endDateFilter}
                                onChange={e => setEndDateFilter(e.target.value)}
                                min={startDateFilter}
                                className={`w-auto ${modalInputStyle}`}
                             />
                             <Button onClick={() => { setStartDateFilter(''); setEndDateFilter(''); }}>Limpiar</Button>
                        </div>
                    </div>

                    <div className="mt-2 space-y-2 max-h-40 overflow-y-auto border rounded-md p-2 bg-muted/50">
                        {filteredNotes.length > 0 ? (
                             filteredNotes.map((note: ECNNote) => (
                                <div key={note.id} className="p-2 bg-muted rounded-md text-sm">
                                   <p className="text-foreground whitespace-pre-wrap">{note.text}</p>
                                   <p className="text-xs text-muted-foreground text-right">{new Date(note.date).toLocaleString()}</p>
                               </div>
                           ))
                        ) : (
                            <p className="text-sm text-muted-foreground p-2">No hay notas para este ECN o que coincidan con el filtro.</p>
                        )}
                    </div>
                </div>

                <div className="flex justify-end pt-4 space-x-2">
                    <Button onClick={handleExportDetailsCsv} variant="secondary">Exportar CSV</Button>
                    <Button onClick={onClose}>Cerrar</Button>
                </div>
            </div>
        </Modal>
    );
};

interface EcnNotesModalProps {
    ecn: ECN | null;
    isOpen: boolean;
    onClose: () => void;
    onNoteAdded: () => void;
    users: User[];
}
const EcnNotesModal: React.FC<EcnNotesModalProps> = ({ ecn, isOpen, onClose, onNoteAdded, users }) => {
    const [newNote, setNewNote] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    
    const userMap = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);
    
    const groupedNotes = useMemo(() => {
        if (!ecn) return [];
        const groups: { [key: string]: ECNNote[] } = {};
        // Reverse to show newest notes first within a day
        ecn.notes.slice().reverse().forEach(note => {
            const date = new Date(note.date).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
            if (!groups[date]) {
                groups[date] = [];
            }
            groups[date].push(note);
        });
        return Object.entries(groups).map(([date, notes]) => ({ date, notes }));
    }, [ecn]);

    if (!isOpen) return null;
    if (!ecn || ecn.id === 'loading') {
        return (
            <Modal isOpen={true} onClose={onClose} title="Cargando...">
                <LoadingIndicator message="Cargando notas del ECN..." />
            </Modal>
        );
    }

    const handleAddNote = async () => {
        if (!newNote.trim()) return;
        setIsSaving(true);
        try {
            await api.addNoteToEcn(ecn.id, newNote, 'CurrentUser'); // Assume 'CurrentUser' is handled by backend
            setNewNote('');
            onNoteAdded(); // This will trigger a refetch in the parent
        } catch (error) {
            console.error("Failed to add note:", error);
        } finally {
            setIsSaving(false);
        }
    };
    
    return (
        <Modal isOpen={isOpen} onClose={onClose} title={`Notas para ECN: ${ecn.id}`} size="xl">
            <div className="space-y-4">
                <div>
                    <label htmlFor="new-note" className="block text-sm font-medium text-foreground">Nueva nota</label>
                    <textarea
                        id="new-note"
                        rows={4}
                        className="mt-1 block w-full rounded-md border-border shadow-sm focus:border-ring focus:ring-1 focus:ring-ring sm:text-sm bg-input text-foreground"
                        value={newNote}
                        onChange={(e) => setNewNote(e.target.value)}
                        placeholder="Escribe un comentario..."
                    />
                    <div className="flex justify-end mt-2">
                         <Button variant="primary" onClick={handleAddNote} disabled={isSaving}>
                            {isSaving ? 'Agregando...' : 'Agregar Nota'}
                         </Button>
                    </div>
                </div>
                <div>
                    <h3 className="text-lg font-medium text-foreground">Historial</h3>
                    <div className="mt-2 space-y-4 max-h-60 overflow-y-auto border-t pt-2 px-2 -mx-2 border-border">
                        {groupedNotes.length > 0 ? groupedNotes.map(group => (
                            <div key={group.date} className="relative">
                                <p className="text-xs font-semibold text-muted-foreground bg-muted/50 py-1 px-2 rounded-md z-10 sticky top-0">{group.date}</p>
                                <div className="space-y-2 mt-2 border-l-2 border-border pl-4 ml-2">
                                    {group.notes.map((note, index) => {
                                        const author = userMap.get(note.author);
                                        return (
                                            <div key={note.id} className="p-3 bg-card rounded-md shadow-sm border border-border">
                                                <div className="flex items-center justify-between mb-1">
                                                     {author ? <UserProfile user={author} size="sm" /> : <p className="text-sm font-semibold text-foreground">{note.author}</p>}
                                                    <p className="text-xs text-muted-foreground">{new Date(note.date).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</p>
                                                </div>
                                                <p className="text-sm text-foreground whitespace-pre-wrap">{note.text}</p>
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>
                        )) : <p className="text-sm text-muted-foreground px-2">Sin notas.</p>}
                    </div>
                </div>
            </div>
        </Modal>
    );
};

// --- Dashboard Component ---
const ITEMS_PER_PAGE = 5;
const LOADING_ECN: ECN = { id: 'loading', initiator: '', description: '', status: ECNStatus.Pending, creationDate: '', implementationDate: '', daysRemaining: 0, changes: [], notes: [], auditLog: [], checklist: [] };

const StatusCard: React.FC<{ title: string; value: number; icon: React.ReactNode; colorClass: string }> = ({ title, value, icon, colorClass }) => (
    <Card className="!p-0">
        <div className="flex items-center">
            <div className={`p-4 rounded-l-lg ${colorClass} bg-opacity-20`}>
                {icon}
            </div>
            <div className="px-4">
                <p className="text-sm font-medium text-muted-foreground uppercase">{title}</p>
                <p className="text-2xl font-bold text-foreground">{value}</p>
            </div>
        </div>
    </Card>
);

const PendingIcon = () => <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-brand-pending" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
const PartialIcon = () => <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-brand-partial" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
const ImplementedIcon = () => <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-brand-implemented" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
const CanceledIcon = () => <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;

const ChevronUpIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="m18 15-6-6-6 6"/></svg>;
const ChevronDownIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="m6 9 6 6 6-6"/></svg>;

const CustomStatusSummaryBarTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
        return (
             <Card className="!p-2 !shadow-lg opacity-90">
                <p className="font-bold text-sm text-foreground">{label}</p>
                {payload.slice().reverse().map((p: any) => (
                    <p key={p.dataKey} className="text-sm text-muted-foreground">
                        <span style={{color: p.fill}}>●</span> {p.name}: <strong>{p.value}</strong>
                    </p>
                ))}
            </Card>
        );
    }
    return null;
};

const Dashboard: React.FC<{ users: User[] }> = ({ users }) => {
    const [ecns, setEcns] = useState<ECN[]>([]);
    const [chartData, setChartData] = useState<ECN[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isChartsLoading, setIsChartsLoading] = useState(true);
    const [chartsError, setChartsError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState('Todos');
    // Default view: ECNs for the current year
    const [timeFilter, setTimeFilter] = useState<string>(`year-${new Date().getFullYear()}`);
    const [sortBy, setSortBy] = useState<SortableKeys>('daysRemaining');
    const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
    const [currentPage, setCurrentPage] = useState(1);
    const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
    const [isNotesModalOpen, setIsNotesModalOpen] = useState(false);
    const [selectedEcn, setSelectedEcn] = useState<ECN | null>(null);
    const [isGeneratingSummary, setIsGeneratingSummary] = useState<string | null>(null);
    const [notification, setNotification] = useState<{message: string, type: 'success' | 'error'} | null>(null);
    const [descriptionModal, setDescriptionModal] = useState<{ isOpen: boolean; content: string, title: string }>({ isOpen: false, content: '', title: '' });
    const [familySearch, setFamilySearch] = useState('');
    const [familyViewMode, setFamilyViewMode] = useState<'cards' | 'table'>('cards');
    const [selectedFamily, setSelectedFamily] = useState<string | null>(null);
    const [familyModalStatus, setFamilyModalStatus] = useState<string>(ECNStatus.Pending);
    const [familyModalSearch, setFamilyModalSearch] = useState('');
    const openFamilyModal = (family: string) => {
        setFamilyModalStatus(ECNStatus.Pending);
        setFamilyModalSearch('');
        setSelectedFamily(family);
    };
    const selectedFamilyEcns = useMemo(() => selectedFamily === null ? [] : chartData.filter(ecn => {
        const families = ecn.familyList?.split(',').map(family => family.trim()).filter(Boolean) || [];
        return (families.length ? families : ['Sin Familia']).includes(selectedFamily);
    }), [selectedFamily, chartData]);
    const visibleFamilyEcns = useMemo(() => {
        const query = familyModalSearch.trim().toLocaleLowerCase('es');
        return selectedFamilyEcns.filter(ecn =>
            (familyModalStatus === 'Todos' || ecn.status === familyModalStatus) &&
            (!query || [ecn.id, ecn.description, ecn.familyList, ecn.skuList].some(value => value?.toLocaleLowerCase('es').includes(query)))
        );
    }, [selectedFamilyEcns, familyModalStatus, familyModalSearch]);
    const { theme } = useTheme();
    const [areChartsVisible, setAreChartsVisible] = useState(() => {
        return localStorage.getItem('dashboardChartsVisible') !== 'false';
    });
    const [themeColors, setThemeColors] = useState({
        pending: 'hsl(39 96% 54%)',
        implemented: 'hsl(145 78% 40%)',
        partialImplemented: 'hsl(217 91% 60%)',
        destructive: 'hsl(0 84% 60%)',
        foreground: 'hsl(210 4% 20%)',
        border: 'hsl(240 5% 88%)',
        card: 'hsl(0 0% 100%)',
        primary: 'hsl(0 69% 50%)'
    });

    const PIE_COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#AF19FF'];
    
    useEffect(() => {
        localStorage.setItem('dashboardChartsVisible', String(areChartsVisible));
    }, [areChartsVisible]);

    useEffect(() => {
        const style = getComputedStyle(document.body);
        setThemeColors({
            primary: `hsl(${style.getPropertyValue('--primary')})`,
            destructive: `hsl(${style.getPropertyValue('--destructive')})`,
            pending: `hsl(${style.getPropertyValue('--brand-pending')})`,
            implemented: `hsl(${style.getPropertyValue('--brand-implemented')})`,
            partialImplemented: `hsl(${style.getPropertyValue('--brand-partial')})`,
            foreground: `hsl(${style.getPropertyValue('--foreground')})`,
            border: `hsl(${style.getPropertyValue('--border')})`,
            card: `hsl(${style.getPropertyValue('--card')})`,
        });
    }, [theme]);


    const fetchData = useCallback(async (isAutoUpdateCheck = false) => {
        if (!isAutoUpdateCheck) {
            setIsLoading(true);
        }
        setError(null);
        try {
            const params: { [key: string]: any } = { search, status, sortBy, sortDirection };
            if (timeFilter.startsWith('year-')) {
                params.year = timeFilter.split('-')[1];
            } else if (timeFilter !== 'all') {
                params.timeFilter = timeFilter;
            }
            
            const ecnsData = await api.getEcns(params);
            
            const ecnsWithCalculatedDays = ecnsData.map(ecn => ({
                ...ecn,
                daysRemaining: calculateDaysRemaining(ecn.implementationDate)
            }));

            // --- Automatic Status Update Logic ---
            const ecnsToUpdate = ecnsWithCalculatedDays.filter(
                ecn => ecn.status === ECNStatus.Pending && ecn.daysRemaining <= 0
            );

            if (ecnsToUpdate.length > 0 && !isAutoUpdateCheck) {
                setNotification({
                    message: `Se detectaron ${ecnsToUpdate.length} ECNs vencidos. Actualizando estado a 'Implementado' y enviando notificaciones...`,
                    type: 'success'
                });

                const updatePromises = ecnsToUpdate.map(async (ecnToUpdate) => {
                    try {
                        // CRITICAL FIX: Fetch the full ECN details to prevent component deletion.
                        const fullEcnDetails = await api.getEcnById(ecnToUpdate.id);
                        const updatedEcn = { ...fullEcnDetails, status: ECNStatus.Implemented };

                        await api.updateEcn(updatedEcn, 'Sistema Automático');
                        await api.sendEcnImplementedNotification(fullEcnDetails);
                    } catch (error) {
                        console.error(`Failed to auto-update ECN ${ecnToUpdate.id}:`, error);
                    }
                });
    
                await Promise.allSettled(updatePromises);
    
                // After all updates, refetch data to show the latest state.
                await fetchData(true); // Keep the loading state until refreshed records are available.
                return; // Exit current execution to avoid setting state with stale data.
            }
            // --- End of Automatic Status Update Logic ---
            
            // --- Client-side Sorting ---
            const sortedEcns = [...ecnsWithCalculatedDays].sort((a, b) => {
                let valA: any = a[sortBy as keyof ECN] ?? '';
                let valB: any = b[sortBy as keyof ECN] ?? '';

                // Special handling for daysRemaining
                if (sortBy === 'daysRemaining') {
                    if (valA === valB) return 0;
                    if (valA === Infinity) return 1;
                    if (valB === Infinity) return -1;
                    return sortDirection === 'asc' ? (valA - valB) : (valB - valA);
                }

                // Handle strings (case-insensitive)
                if (typeof valA === 'string' && typeof valB === 'string') {
                    const comparison = valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
                    return sortDirection === 'asc' ? comparison : -comparison;
                }

                // General numeric or date comparison
                if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
                if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
                return 0;
            });

            setEcns(sortedEcns);
            
        } catch (err) {
            setError('No se pudieron cargar los ECNs. Intente de nuevo.');
            console.error(err);
        } finally {
            setIsLoading(false);
        }
    }, [search, status, timeFilter, sortBy, sortDirection]);

    const fetchChartData = useCallback(async () => {
        setIsChartsLoading(true);
        setChartsError(null);
        try {
            const params: { [key: string]: any } = {};
             if (timeFilter.startsWith('year-')) {
                params.year = timeFilter.split('-')[1];
            } else if (timeFilter !== 'all') {
                params.timeFilter = timeFilter;
            }
            const data = await api.getEcns(params);
            setChartData(data);
        } catch(e) {
            console.error("Failed to fetch chart data:", e);
            setChartsError('No se pudieron cargar las gráficas y las familias.');
        } finally {
            setIsChartsLoading(false);
        }
    }, [timeFilter]);


    useEffect(() => {
        setIsLoading(true);
        setIsChartsLoading(true);
        const handler = setTimeout(() => {
            fetchData();
            fetchChartData();
        }, 300); 
        return () => clearTimeout(handler);
    }, [fetchData, fetchChartData]);
    
    // Auto-sort when status changes
    useEffect(() => {
        if (status === ECNStatus.Implemented) {
            setSortBy('implementationDate');
            setSortDirection('desc');
        } else if (status === ECNStatus.Pending) {
            setSortBy('daysRemaining');
            setSortDirection('asc');
        }
    }, [status]);

    // Update time filter to a sensible default when status changes
    useEffect(() => {
        if (status === ECNStatus.Pending) {
            setTimeFilter('next-60');
        } else if (status === ECNStatus.Implemented) {
            setTimeFilter('last-30');
        } else {
            setTimeFilter(`year-${new Date().getFullYear()}`);
        }
    }, [status]);

    const handleOpenDetails = useCallback(async (ecnId: string) => {
        setSelectedEcn(LOADING_ECN); 
        setIsDetailModalOpen(true);
        try {
            const ecnData = await api.getEcnById(ecnId);
            setSelectedEcn(ecnData);
        } catch (error) {
            console.error("Failed to load ECN details:", error);
            setSelectedEcn(null);
            setIsDetailModalOpen(false);
            setNotification({ message: `No se pudo cargar el ECN ${ecnId}.`, type: 'error' });
            setEcns(prevEcns => prevEcns.filter(e => e.id !== ecnId));
        }
    }, []);

    const handleOpenNotes = useCallback(async (ecnId: string) => {
        setSelectedEcn(LOADING_ECN);
        setIsNotesModalOpen(true);
         try {
            const ecnData = await api.getEcnById(ecnId);
            setSelectedEcn(ecnData);
        } catch (error) {
            console.error("Failed to load ECN notes:", error);
            setSelectedEcn(null);
            setIsNotesModalOpen(false);
            setNotification({ message: `No se pudo cargar el ECN ${ecnId}.`, type: 'error' });
            setEcns(prevEcns => prevEcns.filter(e => e.id !== ecnId));
        }
    }, []);

    const handleOpenDescription = (ecn: ECN) => {
        setDescriptionModal({
            isOpen: true,
            content: ecn.description || 'Sin descripción.',
            title: `Descripción ECN: ${ecn.id}`
        });
    };

    const handleGenerateSummary = async (ecnId: string, forceRefresh: boolean = false) => {
        const ecn = ecns.find(e => e.id === ecnId);
        if (ecn && ecn.summary && !forceRefresh) {
            handleOpenDetails(ecnId);
            return;
        }

        setIsGeneratingSummary(ecnId);
        try {
            if (!forceRefresh) {
                const ecnData = await api.getEcnById(ecnId);
                if (ecnData.summary) {
                    setEcns(prev => prev.map(e => e.id === ecnId ? { ...e, summary: ecnData.summary } : e));
                    handleOpenDetails(ecnId);
                    return;
                }
            }

            const summary = await api.generateEcnSummary(ecnId);
            await api.updateEcnSummary(ecnId, summary);
            
            setEcns(prev => prev.map(e => e.id === ecnId ? { ...e, summary } : e));
            setSelectedEcn(prev => prev && prev.id === ecnId ? { ...prev, summary } : prev);
            setNotification({ message: 'Resumen en español generado y guardado exitosamente.', type: 'success' });
            if (!isDetailModalOpen) {
                handleOpenDetails(ecnId);
            }
        } catch (error) {
            console.error("Failed to generate summary:", error);
            setNotification({ message: (error as Error).message, type: 'error' });
        } finally {
            setIsGeneratingSummary(null);
        }
    };

    const handleSort = (key: SortableKeys) => {
        if (sortBy === key) {
            setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortBy(key);
            setSortDirection('asc');
        }
    };

    const paginatedEcns = useMemo(() => {
        const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
        return ecns.slice(startIndex, startIndex + ITEMS_PER_PAGE);
    }, [ecns, currentPage]);
    
    const [groupingMode, setGroupingMode] = useState<'none' | 'family'>('none');

    const groupedEcnsByFamily = useMemo(() => {
        if (groupingMode !== 'family') return null;
        const groups: { [family: string]: ECN[] } = {};
        ecns.forEach(ecn => {
            const fams = ecn.familyList ? ecn.familyList.split(',').map(f => f.trim()).filter(Boolean) : ['Sin Familia'];
            fams.forEach(fam => {
                if (!groups[fam]) groups[fam] = [];
                groups[fam].push(ecn);
            });
        });
        return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
    }, [ecns, groupingMode]);

    const totalPages = Math.ceil(ecns.length / ITEMS_PER_PAGE);

    const statusSummary = useMemo(() => {
        const summary = {
            [ECNStatus.Pending]: 0,
            [ECNStatus.Implemented]: 0,
            [ECNStatus.Canceled]: 0,
            [ECNStatus.PartialImplemented]: 0,
        };
        ecns.forEach(ecn => {
            if (ecn.status in summary) {
                summary[ecn.status]++;
            }
        });
        return summary;
    }, [ecns]);
    
    const ecnStatusByPeriodData = useMemo(() => {
        if (chartData.length === 0) return [];
        
        const statusData: { [key: string]: { [ECNStatus.Pending]: number, [ECNStatus.Implemented]: number, [ECNStatus.Canceled]: number, [ECNStatus.PartialImplemented]: number } } = {};

        const processEcn = (ecn: ECN, key: string | null) => {
            if (!key) return;
            if (!statusData[key]) {
                statusData[key] = { [ECNStatus.Pending]: 0, [ECNStatus.Implemented]: 0, [ECNStatus.Canceled]: 0, [ECNStatus.PartialImplemented]: 0 };
            }
            if (ecn.status in statusData[key]) {
                 statusData[key][ecn.status]++;
            }
        };
        
        let groupedData: {name: string, [key: string]: any}[] = [];

        if (timeFilter.startsWith('year-')) {
            const year = timeFilter.split('-')[1];
            chartData.forEach(ecn => {
                if (ecn.creationDate && ecn.creationDate.startsWith(year)) {
                    const month = new Date(ecn.creationDate).toLocaleString('es-ES', { month: 'short' }).replace('.', '');
                    processEcn(ecn, month);
                }
            });
            const monthOrder = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
            monthOrder.forEach(month => {
                if(statusData[month]) {
                    groupedData.push({ name: month.charAt(0).toUpperCase() + month.slice(1), ...statusData[month] });
                }
            });

        } else if (timeFilter.startsWith('last-') || timeFilter.startsWith('next-')) {
             chartData.forEach(ecn => {
                const dateStr = ecn.implementationDate || ecn.creationDate; 
                if (dateStr) {
                    try {
                        const date = new Date(dateStr);
                        const day = date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
                        processEcn(ecn, day);
                    } catch(e) {/* ignore invalid date */}
                }
            });
            groupedData = Object.entries(statusData)
                .map(([name, counts]) => ({ name, ...counts }))
                .sort((a,b) => {
                    const [dayA, monthA] = a.name.split('/');
                    const [dayB, monthB] = b.name.split('/');
                    return new Date(0, parseInt(monthA)-1, parseInt(dayA)).getTime() - new Date(0, parseInt(monthB)-1, parseInt(dayB)).getTime();
                });
        } else { // 'all'
             chartData.forEach(ecn => {
                if (ecn.creationDate) {
                    const year = ecn.creationDate.substring(0, 4);
                    processEcn(ecn, year);
                }
            });
            groupedData = Object.entries(statusData).map(([name, counts]) => ({ name, ...counts })).sort((a,b) => a.name.localeCompare(b.name));
        }

        return groupedData;

    }, [chartData, timeFilter]);

    const implementationTimeData = useMemo(() => {
        const implementedEcns = chartData.filter(
            ecn => ecn.status === ECNStatus.Implemented && ecn.creationDate && ecn.implementationDate
        );

        const categories = {
            '0-30 días': 0,
            '31-60 días': 0,
            '61-90 días': 0,
            '91-180 días': 0,
            '181+ días': 0,
        };

        implementedEcns.forEach(ecn => {
            const creation = new Date(ecn.creationDate);
            const implementation = new Date(ecn.implementationDate);
            if (isNaN(creation.getTime()) || isNaN(implementation.getTime())) {
                return; // Skip if dates are invalid
            }
            const diffTime = implementation.getTime() - creation.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays <= 30) {
                categories['0-30 días']++;
            } else if (diffDays <= 60) {
                categories['31-60 días']++;
            } else if (diffDays <= 90) {
                categories['61-90 días']++;
            } else if (diffDays <= 180) {
                categories['91-180 días']++;
            } else {
                categories['181+ días']++;
            }
        });

        return Object.entries(categories)
            .map(([name, value]) => ({ name, value }))
            .filter(entry => entry.value > 0); // Only show categories with data

    }, [chartData]);

    const familyEcnData = useMemo(() => {
        const map = new Map<string, {
            name: string;
            total: number;
            pending: number;
            partial: number;
            implemented: number;
            canceled: number;
        }>();

        chartData.forEach(ecn => {
            const fams = ecn.familyList ? ecn.familyList.split(',').map(f => f.trim()).filter(Boolean) : ['Sin Familia'];
            fams.forEach(fam => {
                if (!map.has(fam)) {
                    map.set(fam, {
                        name: fam,
                        total: 0,
                        pending: 0,
                        partial: 0,
                        implemented: 0,
                        canceled: 0
                    });
                }
                const entry = map.get(fam)!;
                entry.total += 1;
                if (ecn.status === ECNStatus.Pending) {
                    entry.pending += 1;
                } else if (ecn.status === ECNStatus.PartialImplemented) {
                    entry.partial += 1;
                } else if (ecn.status === ECNStatus.Implemented) {
                    entry.implemented += 1;
                } else if (ecn.status === ECNStatus.Canceled) {
                    entry.canceled += 1;
                }
            });
        });

        return Array.from(map.values())
            .map(item => ({
                ...item,
                percentImplemented: item.total > 0 ? Math.round((item.implemented / item.total) * 100) : 0
            }))
            .sort((a, b) => b.total - a.total);
    }, [chartData]);

    const filteredFamilyEcnData = useMemo(() => {
        if (!familySearch.trim()) return familyEcnData;
        const q = familySearch.toLowerCase();
        return familyEcnData.filter(f => f.name.toLowerCase().includes(q));
    }, [familyEcnData, familySearch]);

    const familyTotals = useMemo(() => {
        const res = { families: familyEcnData.length, total: 0, pending: 0, partial: 0, implemented: 0, canceled: 0 };
        familyEcnData.forEach(f => {
            res.total += f.total;
            res.pending += f.pending;
            res.partial += f.partial;
            res.implemented += f.implemented;
            res.canceled += f.canceled;
        });
        return res;
    }, [familyEcnData]);

    const availableYears = useMemo(() => {
        const years = new Set<number>();
        ecns.forEach(ecn => {
            if (ecn.creationDate) {
                try { years.add(new Date(ecn.creationDate).getFullYear()); } catch(e) {/* ignore */}
            }
        });
        return Array.from(years).sort((a, b) => b - a);
    }, [ecns]);

    const timeFilterOptions = useMemo(() => {
        if (status === ECNStatus.Pending) {
            return [
                { value: 'next-30', label: 'Próximos 30 días' },
                { value: 'next-60', label: 'Próximos 60 días' },
                { value: 'next-90', label: 'Próximos 90 días' },
            ];
        }
        if (status === ECNStatus.Implemented) {
            return [
                { value: 'last-30', label: 'Últimos 30 días' },
                { value: 'last-60', label: 'Últimos 60 días' },
                { value: 'last-90', label: 'Últimos 90 días' },
            ];
        }
        // Default for 'Todos' or 'Cancelado'
        const currentYear = new Date().getFullYear();
        const yearOptions = availableYears.map(year => ({
            value: `year-${year}`,
            label: `${year}`,
        }));

        const finalOptions = [
            { value: 'all', label: 'Todos los tiempos' },
        ];

        // Add "Año en curso" if it exists in the data or is the current year
        if (availableYears.includes(currentYear)) {
             finalOptions.push({ value: `year-${currentYear}`, label: `Año en curso (${currentYear})` });
        } else {
             finalOptions.push({ value: `year-${currentYear}`, label: `Año en curso (${currentYear})` });
        }
        
        // Add other unique years
        yearOptions.forEach(opt => {
            if (opt.value !== `year-${currentYear}`) {
                finalOptions.push(opt);
            }
        });

        return finalOptions;
    }, [status, availableYears]);


    const handleNoteAdded = async () => {
        if (selectedEcn) {
            try {
                const updatedEcn = await api.getEcnById(selectedEcn.id);
                // Ensure daysRemaining is computed to avoid NaN in the table
                updatedEcn.daysRemaining = calculateDaysRemaining(updatedEcn.implementationDate);
                setSelectedEcn(updatedEcn);
                setEcns(prev => prev.map(e => e.id === updatedEcn.id ? updatedEcn : e));
            } catch (error) {
                console.error("Failed to refetch ECN after adding note:", error);
                const ecnId = selectedEcn.id;
                setIsNotesModalOpen(false);
                setSelectedEcn(null);
                setNotification({ message: `No se pudo actualizar el ECN ${ecnId}.`, type: 'error' });
                setEcns(prevEcns => prevEcns.filter(e => e.id !== ecnId));
            }
        }
    };
    
    const handleExport = () => {
        const dataToExport = ecns.map(ecn => {
            const initiatorUser = users.find(u => u.id === ecn.initiator);
            return {
                'ECN': ecn.id,
                'Familia(s)': ecn.familyList || 'Sin Familia',
                'Iniciador': initiatorUser ? initiatorUser.name : ecn.initiator,
                'Descripción': ecn.description,
                'Estatus': ecn.status,
                'Fecha de Creación': formatDate(ecn.creationDate),
                'Fecha de Implementación': formatDate(ecn.implementationDate),
                'Días Restantes': ecn.status === ECNStatus.Implemented ? 0 : (ecn.daysRemaining === Infinity ? 'N/A' : Math.max(0, ecn.daysRemaining))
            };
        });
        exportToCsv(`dashboard_ecns_${new Date().toISOString().split('T')[0]}.csv`, dataToExport);
    };

    const renderSortArrow = (key: SortableKeys) => {
        if (sortBy !== key) return null;
        return sortDirection === 'asc' ? ' ▲' : ' ▼';
    };

    return (
        <div className="space-y-6">
             {notification && <Toast message={notification.message} type={notification.type} onClose={() => setNotification(null)} />}
            {(isLoading || isChartsLoading) && <div className="sticky top-0 z-30 rounded-xl border border-primary/20 bg-card/95 shadow-sm backdrop-blur-sm"><LoadingIndicator message={isLoading && isChartsLoading ? 'Cargando dashboard y gráficas...' : isChartsLoading ? 'Actualizando gráficas y familias...' : 'Cargando registros de ECN...'} /></div>}
            <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <h1 className="text-3xl font-bold text-foreground">Dashboard de ECNs</h1>
                    <button
                        onClick={() => setAreChartsVisible(prev => !prev)}
                        className="p-1 rounded-full hover:bg-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-expanded={areChartsVisible}
                        aria-controls="charts-container"
                        aria-label={areChartsVisible ? "Ocultar gráficos" : "Mostrar gráficos"}
                    >
                        {areChartsVisible ? <ChevronUpIcon /> : <ChevronDownIcon />}
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                 <StatusCard title="Pendiente" value={statusSummary[ECNStatus.Pending]} icon={<PendingIcon />} colorClass="bg-brand-pending" />
                 <StatusCard title="Implementado Parcial" value={statusSummary[ECNStatus.PartialImplemented]} icon={<PartialIcon />} colorClass="bg-brand-partial" />
                 <StatusCard title="Implementado" value={statusSummary[ECNStatus.Implemented]} icon={<ImplementedIcon />} colorClass="bg-brand-implemented" />
                 <StatusCard title="Cancelado" value={statusSummary[ECNStatus.Canceled]} icon={<CanceledIcon />} colorClass="bg-destructive" />
            </div>

            <Card className="!p-5 border border-border bg-card shadow-sm">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4 pb-3 border-b border-border">
                    <div>
                        <div className="flex items-center gap-2">
                            <h3 className="text-lg font-bold text-foreground">Cantidad de ECNs por Familia</h3>
                            <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-primary/10 text-primary border border-primary/20">
                                {familyTotals.families} {familyTotals.families === 1 ? 'Familia' : 'Familias'}
                            </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            Distribución de estatus por familia de producto: total de ECNs, pendientes, parciales e implementados.
                        </p>
                    </div>

                    <div className="flex items-center gap-2 w-full sm:w-auto">
                        <div className="relative flex-1 sm:w-48">
                            <input
                                type="text"
                                placeholder="Buscar familia..."
                                value={familySearch}
                                onChange={(e) => setFamilySearch(e.target.value)}
                                className="w-full pl-7 pr-2.5 py-1 text-xs border border-input rounded-md bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                            />
                            <svg className="w-3.5 h-3.5 text-muted-foreground absolute left-2 top-2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                        </div>

                        <div className="inline-flex rounded-md border border-border p-0.5 bg-muted/40">
                            <button
                                type="button"
                                onClick={() => setFamilyViewMode('cards')}
                                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                                    familyViewMode === 'cards'
                                        ? 'bg-card text-foreground shadow-xs font-semibold'
                                        : 'text-muted-foreground hover:text-foreground'
                                }`}
                                title="Vista de tarjetas"
                            >
                                Tarjetas
                            </button>
                            <button
                                type="button"
                                onClick={() => setFamilyViewMode('table')}
                                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                                    familyViewMode === 'table'
                                        ? 'bg-card text-foreground shadow-xs font-semibold'
                                        : 'text-muted-foreground hover:text-foreground'
                                }`}
                                title="Vista de tabla"
                            >
                                Tabla
                            </button>
                        </div>
                    </div>
                </div>

                {isChartsLoading ? <LoadingIndicator message="Cargando familias y sus ECNs..." /> : chartsError ? (
                    <div className="py-6 text-center"><p className="mb-3 text-sm text-destructive">{chartsError}</p><Button onClick={() => fetchChartData()}>Reintentar</Button></div>
                ) : filteredFamilyEcnData.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                        No hay datos de familias para el período o búsqueda seleccionada.
                    </div>
                ) : familyViewMode === 'cards' ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
                        {filteredFamilyEcnData.map(item => (
                            <div
                                key={item.name}
                                role="button"
                                tabIndex={0}
                                aria-label={`Ver los ${item.total} ECNs de ${item.name}`}
                                onClick={() => openFamilyModal(item.name)}
                                onKeyDown={event => {
                                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFamilyModal(item.name); }
                                }}
                                className="p-3.5 bg-muted/20 hover:bg-muted/40 border border-border rounded-xl flex flex-col justify-between transition-all hover:shadow-sm cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                            >
                                <div>
                                    <div className="flex justify-between items-start gap-2 mb-2">
                                        <div className="min-w-0 flex-1">
                                            <span className="text-xs uppercase tracking-wider font-semibold text-muted-foreground block truncate" title={item.name}>
                                                {item.name}
                                            </span>
                                            <div className="flex items-baseline gap-1 mt-0.5">
                                                <span className="text-2xl font-black text-foreground font-mono">
                                                    {item.total}
                                                </span>
                                                <span className="text-xs font-medium text-muted-foreground">
                                                    {item.total === 1 ? 'ECN' : 'ECNs'}
                                                </span>
                                            </div>
                                        </div>
                                        <span className="px-2 py-0.5 text-[11px] font-bold rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 whitespace-nowrap">
                                            {item.percentImplemented}% impl.
                                        </span>
                                    </div>

                                    {/* Progress Stack Bar */}
                                    <div
                                        className="w-full h-2 bg-muted rounded-full overflow-hidden flex mb-3 border border-border/50"
                                        title={`Implementados: ${item.implemented}, Parciales: ${item.partial}, Pendientes: ${item.pending}${item.canceled ? `, Cancelados: ${item.canceled}` : ''}`}
                                    >
                                        {item.implemented > 0 && (
                                            <div
                                                style={{ width: `${(item.implemented / item.total) * 100}%` }}
                                                className="bg-brand-implemented h-full transition-all duration-300"
                                            />
                                        )}
                                        {item.partial > 0 && (
                                            <div
                                                style={{ width: `${(item.partial / item.total) * 100}%` }}
                                                className="bg-brand-partial h-full transition-all duration-300"
                                            />
                                        )}
                                        {item.pending > 0 && (
                                            <div
                                                style={{ width: `${(item.pending / item.total) * 100}%` }}
                                                className="bg-brand-pending h-full transition-all duration-300"
                                            />
                                        )}
                                        {item.canceled > 0 && (
                                            <div
                                                style={{ width: `${(item.canceled / item.total) * 100}%` }}
                                                className="bg-destructive h-full transition-all duration-300"
                                            />
                                        )}
                                    </div>

                                    {/* 3 Metric Pills: Pendientes, Parciales, Implementados */}
                                    <div className="grid grid-cols-3 gap-1.5 text-center">
                                        <div className="p-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                                            <div className="text-base font-extrabold text-amber-700 dark:text-amber-400 font-mono">
                                                {item.pending}
                                            </div>
                                            <div className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 truncate">
                                                Pendientes
                                            </div>
                                        </div>

                                        <div className="p-1.5 rounded-lg bg-sky-500/10 border border-sky-500/20">
                                            <div className="text-base font-extrabold text-sky-700 dark:text-sky-400 font-mono">
                                                {item.partial}
                                            </div>
                                            <div className="text-[10px] font-semibold text-sky-600 dark:text-sky-400 truncate">
                                                Parciales
                                            </div>
                                        </div>

                                        <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                                            <div className="text-base font-extrabold text-emerald-700 dark:text-emerald-400 font-mono">
                                                {item.implemented}
                                            </div>
                                            <div className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 truncate">
                                                Implement.
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {item.canceled > 0 && (
                                    <div className="mt-2.5 pt-1.5 border-t border-border/50 flex justify-between items-center text-[10px] text-muted-foreground">
                                        <span>Cancelados:</span>
                                        <span className="font-semibold text-destructive">{item.canceled}</span>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="overflow-x-auto border border-border rounded-lg">
                        <table className="min-w-full divide-y divide-border text-xs">
                            <thead className="bg-muted/50 font-semibold text-muted-foreground uppercase tracking-wider">
                                <tr>
                                    <th className="px-4 py-2.5 text-left">Familia de Producto</th>
                                    <th className="px-4 py-2.5 text-center">Total ECNs</th>
                                    <th className="px-4 py-2.5 text-center">Pendientes</th>
                                    <th className="px-4 py-2.5 text-center">Parciales</th>
                                    <th className="px-4 py-2.5 text-center">Implementados</th>
                                    <th className="px-4 py-2.5 text-center">Cancelados</th>
                                    <th className="px-4 py-2.5 text-left">Avance de Implementación</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border bg-card">
                                {filteredFamilyEcnData.map(item => (
                                    <tr key={item.name} role="button" tabIndex={0}
                                        aria-label={`Ver los ${item.total} ECNs de ${item.name}`}
                                        onClick={() => openFamilyModal(item.name)}
                                        onKeyDown={event => {
                                            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFamilyModal(item.name); }
                                        }}
                                        className="hover:bg-muted/30 transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                                        <td className="px-4 py-2.5 font-bold text-foreground">{item.name}</td>
                                        <td className="px-4 py-2.5 text-center font-bold text-primary font-mono">{item.total}</td>
                                        <td className="px-4 py-2.5 text-center">
                                            <span className="px-2 py-0.5 rounded-full font-bold bg-amber-500/15 text-amber-700 dark:text-amber-400 font-mono">
                                                {item.pending}
                                            </span>
                                        </td>
                                        <td className="px-4 py-2.5 text-center">
                                            <span className="px-2 py-0.5 rounded-full font-bold bg-sky-500/15 text-sky-700 dark:text-sky-400 font-mono">
                                                {item.partial}
                                            </span>
                                        </td>
                                        <td className="px-4 py-2.5 text-center">
                                            <span className="px-2 py-0.5 rounded-full font-bold bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 font-mono">
                                                {item.implemented}
                                            </span>
                                        </td>
                                        <td className="px-4 py-2.5 text-center text-muted-foreground">
                                            {item.canceled > 0 ? (
                                                <span className="px-2 py-0.5 rounded-full font-bold bg-destructive/15 text-destructive font-mono">
                                                    {item.canceled}
                                                </span>
                                            ) : '—'}
                                        </td>
                                        <td className="px-4 py-2.5">
                                            <div className="flex items-center gap-2">
                                                <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden flex">
                                                    <div
                                                        style={{ width: `${item.percentImplemented}%` }}
                                                        className="bg-brand-implemented h-full rounded-full transition-all duration-300"
                                                    />
                                                </div>
                                                <span className="font-semibold text-foreground text-[11px] w-10 text-right font-mono">
                                                    {item.percentImplemented}%
                                                </span>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>
            
            <div 
                id="charts-container"
                aria-busy={isChartsLoading}
                className={`relative transition-all duration-500 ease-in-out overflow-hidden ${areChartsVisible ? 'max-h-[1000px] opacity-100' : 'max-h-0 opacity-0'}`}
            >
                {(isChartsLoading || chartsError) && <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-background/90 backdrop-blur-sm">{isChartsLoading ? <LoadingIndicator message="Preparando gráficas..." /> : <div className="text-center"><p className="mb-3 text-sm text-destructive">{chartsError}</p><Button onClick={() => fetchChartData()}>Reintentar</Button></div>}</div>}
                 <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                    <Card className="lg:col-span-3">
                        <h3 className="text-lg font-semibold text-foreground mb-4">Resumen de ECNs por Estado</h3>
                        <div style={{ width: '100%', height: 300 }}>
                            <ResponsiveContainer>
                                <BarChart data={ecnStatusByPeriodData} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                                    <CartesianGrid stroke={themeColors.border} strokeDasharray="3 3" />
                                    <XAxis dataKey="name" stroke={themeColors.foreground} fontSize={12} tickLine={false} axisLine={false} />
                                    <YAxis stroke={themeColors.foreground} fontSize={12} tickLine={false} axisLine={false} />
                                    <Tooltip content={<CustomStatusSummaryBarTooltip />} cursor={{ fill: 'hsl(var(--secondary))' }}/>
                                    <Legend wrapperStyle={{fontSize: "12px", color: themeColors.foreground}}/>
                                    <Bar dataKey={ECNStatus.Pending} name="Pendiente" stackId="a" fill={themeColors.pending} barSize={20} radius={[4, 4, 0, 0]}/>
                                    <Bar dataKey={ECNStatus.PartialImplemented} name="Imp. Parcial" stackId="a" fill={themeColors.partialImplemented} barSize={20} />
                                    <Bar dataKey={ECNStatus.Implemented} name="Implementado" stackId="a" fill={themeColors.implemented} barSize={20} />
                                    <Bar dataKey={ECNStatus.Canceled} name="Cancelado" stackId="a" fill={themeColors.destructive} barSize={20} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </Card>
                    <Card className="lg:col-span-2">
                        <h3 className="text-lg font-semibold text-foreground mb-4">Tiempo de Implementación de ECNs</h3>
                         <div style={{ width: '100%', height: 300 }}>
                            <ResponsiveContainer>
                                {implementationTimeData.length > 0 ? (
                                    <PieChart>
                                        <Pie
                                            data={implementationTimeData}
                                            cx="50%"
                                            cy="50%"
                                            labelLine={false}
                                            outerRadius={80}
                                            fill="#8884d8"
                                            dataKey="value"
                                            nameKey="name"
                                        >
                                            {implementationTimeData.map((entry, index) => (
                                                <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                                            ))}
                                        </Pie>
                                        <Tooltip cursor={{ fill: 'hsl(var(--secondary))' }} />
                                        <Legend wrapperStyle={{fontSize: "12px", color: themeColors.foreground}} />
                                    </PieChart>
                                ) : (
                                    <div className="flex items-center justify-center h-full text-muted-foreground">
                                        No hay datos de implementación para el período seleccionado.
                                    </div>
                                )}
                            </ResponsiveContainer>
                        </div>
                    </Card>
                </div>
            </div>


            <Card>
                <div className="flex flex-wrap gap-4 items-center justify-between mb-6">
                    <div className="flex flex-wrap gap-4 items-center">
                        <input
                            type="text"
                            placeholder="Buscar ECN, iniciador, descripci..."
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            className="w-full sm:w-auto px-4 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring bg-input text-foreground"
                        />
                        <select value={status} onChange={e => setStatus(e.target.value)} className="w-full sm:w-auto px-4 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring bg-input text-foreground">
                            <option value="Todos">Todos</option>
                            <option value={ECNStatus.Pending}>Pendiente</option>
                            <option value={ECNStatus.PartialImplemented}>Implementado Parcial</option>
                            <option value={ECNStatus.Implemented}>Implementado</option>
                            <option value={ECNStatus.Canceled}>Cancelado</option>
                        </select>
                        <select value={timeFilter} onChange={e => setTimeFilter(e.target.value)} className="w-full sm:w-auto px-4 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring bg-input text-foreground">
                           {timeFilterOptions.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                        <select value={groupingMode} onChange={e => setGroupingMode(e.target.value as 'none' | 'family')} className="w-full sm:w-auto px-4 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring bg-input text-foreground">
                            <option value="none">Sin agrupar</option>
                            <option value="family">Agrupar por Familia</option>
                        </select>
                    </div>
                    <div className="flex items-center gap-4">
                        <Button variant="primary" onClick={handleExport}>Exportar CSV</Button>
                        <Link to="/changes" className="text-sm font-medium text-primary hover:underline whitespace-nowrap">Ir al gestor ECN</Link>
                    </div>
                </div>

                 <div className="overflow-x-auto border-t pt-4 border-border">
                    <table className="min-w-[1400px] w-full divide-y divide-border">
                        <thead className="bg-muted/50">
                            <tr>
                                {([
                                    { key: 'id', label: 'ECN' },
                                    { key: 'implementationDate', label: 'Fecha Implementación' },
                                    { key: 'daysRemaining', label: 'Días Restantes' },
                                    { key: 'initiator', label: 'Iniciador' },
                                    { key: 'description', label: 'Descripción' },
                                    { key: 'familyList', label: 'Familia(s)' },
                                    { key: 'status', label: 'Estatus' },
                                ] as { key: SortableKeys, label: string }[]).map(({ key, label }) => (
                                    <th key={key} scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer" onClick={() => handleSort(key)}>
                                        {label}{renderSortArrow(key)}
                                    </th>
                                ))}
                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Acciones</th>
                            </tr>
                        </thead>
                        <tbody className="bg-card divide-y divide-border">
                            {isLoading ? (
                                <tr><td colSpan={8}><LoadingIndicator message="Cargando lista de ECNs..." /></td></tr>
                            ) : error ? (
                                <tr>
                                    <td colSpan={8} className="text-center py-8">
                                        <p className="text-destructive mb-4">{error}</p>
                                        <Button onClick={() => fetchData()}>Intentar de nuevo</Button>
                                    </td>
                                </tr>
                            ) : groupingMode === 'family' && groupedEcnsByFamily ? (
                                groupedEcnsByFamily.length > 0 ? (
                                    groupedEcnsByFamily.map(([family, items]) => (
                                        <React.Fragment key={family}>
                                            <tr>
                                                <td colSpan={8} className="px-6 py-3 bg-muted font-bold text-foreground text-sm">
                                                    Familia: {family} ({items.length} ECNs)
                                                </td>
                                            </tr>
                                            {items.map(ecn => {
                                                const initiator = users.find(u => u.id === ecn.initiator);
                                                return (
                                                    <tr key={ecn.id} className={`${ecn.status === ECNStatus.Implemented ? 'bg-green-500/10 dark:bg-green-500/20' : ''} hover:bg-muted/50`}>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-foreground">{ecn.id}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">{formatDate(ecn.implementationDate)}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                                                            {
                                                                ecn.status === ECNStatus.Implemented ? 0 :
                                                                ecn.daysRemaining === Infinity ? 'N/A' :
                                                                Math.max(0, ecn.daysRemaining)
                                                            }
                                                        </td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                                                            {initiator ? <UserProfile user={initiator} /> : ecn.initiator}
                                                        </td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground max-w-xs">
                                                            <button onClick={() => handleOpenDescription(ecn)} className="block w-full truncate hover:underline focus:outline-none text-left">
                                                                {ecn.description || '—'}
                                                            </button>
                                                        </td>
                                                        <td className="px-6 py-4 text-sm text-muted-foreground min-w-[160px] max-w-xs">{ecn.familyList || 'Sin Familia'}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm"><StatusBadge status={ecn.status} /></td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                                                            <Button onClick={() => handleOpenDetails(ecn.id)}>Detalles</Button>
                                                            <Button 
                                                                onClick={() => handleGenerateSummary(ecn.id)} 
                                                                disabled={isGeneratingSummary === ecn.id}
                                                                variant={ecn.summary ? 'secondary' : 'primary'}
                                                            >
                                                                {isGeneratingSummary === ecn.id ? 'Generando...' : 'Resumen del cambio'}
                                                            </Button>
                                                            <Button onClick={() => handleOpenNotes(ecn.id)}>Notas ({ecn.notes.length})</Button>
                                                            <Link to={`/checklist/${ecn.id}`}>
                                                                <Button>Checklist</Button>
                                                            </Link>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </React.Fragment>
                                    ))
                                ) : (
                                    <tr><td colSpan={8} className="text-center py-4 text-muted-foreground">No se encontraron ECNs.</td></tr>
                                )
                            ) : paginatedEcns.length > 0 ? (
                                paginatedEcns.map(ecn => {
                                    const initiator = users.find(u => u.id === ecn.initiator);
                                    return (
                                        <tr key={ecn.id} className={`${ecn.status === ECNStatus.Implemented ? 'bg-green-500/10 dark:bg-green-500/20' : ''} hover:bg-muted/50`}>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-foreground">{ecn.id}</td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">{formatDate(ecn.implementationDate)}</td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                                                {
                                                    ecn.status === ECNStatus.Implemented ? 0 :
                                                    ecn.daysRemaining === Infinity ? 'N/A' :
                                                    Math.max(0, ecn.daysRemaining)
                                                }
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                                                {initiator ? <UserProfile user={initiator} /> : ecn.initiator}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground max-w-xs">
                                                <button onClick={() => handleOpenDescription(ecn)} className="block w-full truncate hover:underline focus:outline-none text-left">
                                                    {ecn.description || '—'}
                                                </button>
                                            </td>
                                            <td className="px-6 py-4 text-sm text-muted-foreground min-w-[160px] max-w-xs">{ecn.familyList || 'Sin Familia'}</td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm"><StatusBadge status={ecn.status} /></td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                                                <Button onClick={() => handleOpenDetails(ecn.id)}>Detalles</Button>
                                                <Button 
                                                    onClick={() => handleGenerateSummary(ecn.id)} 
                                                    disabled={isGeneratingSummary === ecn.id}
                                                    variant={ecn.summary ? 'secondary' : 'primary'}
                                                >
                                                    {isGeneratingSummary === ecn.id ? 'Generando...' : 'Resumen del cambio'}
                                                </Button>
                                                <Button onClick={() => handleOpenNotes(ecn.id)}>Notas ({ecn.notes.length})</Button>
                                                <Link to={`/checklist/${ecn.id}`}>
                                                    <Button>Checklist</Button>
                                                </Link>
                                            </td>
                                        </tr>
                                    );
                                })
                            ) : (
                                <tr><td colSpan={8} className="text-center py-4 text-muted-foreground">No se encontraron ECNs.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
                {groupingMode === 'none' && <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />}
            </Card>

            <Modal isOpen={selectedFamily !== null} onClose={() => setSelectedFamily(null)}
                title={<span className="flex items-center gap-3"><span className="h-7 w-1 rounded-full bg-primary" />Cambios de ingeniería <span className="rounded-md border border-primary/20 bg-primary/10 px-2.5 py-1 text-sm font-bold text-primary">{selectedFamily}</span></span>} size="wide">
                <div className="space-y-5">
                    <div className="flex flex-col gap-4 rounded-xl border border-border bg-gradient-to-r from-muted/60 to-card p-5 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Seguimiento por familia</p>
                            <h3 className="mt-1 text-xl font-bold text-foreground">ECNs de {selectedFamily}</h3>
                            <p className="mt-1 text-sm text-muted-foreground">Periodo seleccionado en el dashboard. La vista inicia con los cambios pendientes.</p>
                        </div>
                        <div className="flex shrink-0 divide-x divide-border rounded-lg border border-border bg-card">
                            <div className="px-5 py-3"><p className="text-xs text-muted-foreground">Pendientes</p><p className="text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-400">{selectedFamilyEcns.filter(ecn => ecn.status === ECNStatus.Pending).length}</p></div>
                            <div className="px-5 py-3"><p className="text-xs text-muted-foreground">Total de la familia</p><p className="text-2xl font-bold tabular-nums text-foreground">{selectedFamilyEcns.length}</p></div>
                        </div>
                    </div>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                        <div className="w-full sm:w-64">
                            <label htmlFor="family-modal-status" className="mb-1.5 block text-xs font-semibold text-muted-foreground">Estatus del ECN</label>
                            <select id="family-modal-status" value={familyModalStatus} onChange={event => setFamilyModalStatus(event.target.value)} className="w-full rounded-lg border border-input bg-input px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
                                <option value={ECNStatus.Pending}>Pendientes</option>
                                <option value={ECNStatus.PartialImplemented}>Implementados parcialmente</option>
                                <option value={ECNStatus.Implemented}>Implementados</option>
                                <option value={ECNStatus.Canceled}>Cancelados</option>
                                <option value="Todos">Todos los estatus</option>
                            </select>
                        </div>
                        <div className="flex-1">
                            <label htmlFor="family-modal-search" className="mb-1.5 block text-xs font-semibold text-muted-foreground">Buscar en esta familia</label>
                            <input id="family-modal-search" type="search" value={familyModalSearch} onChange={event => setFamilyModalSearch(event.target.value)} placeholder="Buscar ECN, descripción, familia o SKU..." className="w-full rounded-lg border border-input bg-input px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
                        </div>
                        <p className="shrink-0 pb-2 text-xs text-muted-foreground" aria-live="polite"><strong className="text-foreground">{visibleFamilyEcns.length}</strong> de {selectedFamilyEcns.length} ECNs</p>
                    </div>
                <div className="max-h-[48vh] overflow-auto rounded-xl border border-border">
                    <table className="w-full min-w-[1100px] divide-y divide-border text-sm">
                        <thead className="sticky top-0 z-10 bg-muted shadow-sm">
                            <tr>{['ECN', 'Descripción del cambio', 'Familia(s)', 'SKU(s) afectados', 'Implementación', 'Estatus', ''].map(label => <th key={label} scope="col" className="px-4 py-3.5 text-left text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label || <span className="sr-only">Acciones</span>}</th>)}</tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {isChartsLoading ? <tr><td colSpan={7}><LoadingIndicator message="Actualizando ECNs de la familia..." /></td></tr> : visibleFamilyEcns.map(ecn => (
                                <tr key={ecn.id} className="align-top odd:bg-card even:bg-muted/10 hover:bg-primary/5 transition-colors">
                                    <td className="px-4 py-4 whitespace-nowrap"><button onClick={() => handleOpenDetails(ecn.id)} className="font-mono font-bold text-primary hover:underline">{ecn.id}</button></td>
                                    <td className="px-4 py-4 min-w-[260px] max-w-md font-medium leading-relaxed">{ecn.description || 'Sin descripción'}</td>
                                    <td className="px-4 py-4 min-w-[160px]"><div className="flex flex-wrap gap-1">{(ecn.familyList || 'Sin Familia').split(',').map(family => <span key={family} className="rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium">{family.trim()}</span>)}</div></td>
                                    <td className="px-4 py-4 max-w-xs text-xs leading-relaxed text-muted-foreground"><p className="line-clamp-3 break-words" title={ecn.skuList || ''}>{ecn.skuList || 'Sin SKUs registrados'}</p></td>
                                    <td className="px-4 py-4 whitespace-nowrap font-mono text-xs text-muted-foreground">{formatDate(ecn.implementationDate)}</td>
                                    <td className="px-4 py-4 whitespace-nowrap"><StatusBadge status={ecn.status} /></td>
                                    <td className="px-4 py-4 whitespace-nowrap"><Button variant="secondary" onClick={() => handleOpenDetails(ecn.id)}>Ver detalle →</Button></td>
                                </tr>
                            ))}
                            {!isChartsLoading && !visibleFamilyEcns.length && <tr><td colSpan={7} className="px-4 py-12 text-center"><p className="font-semibold text-foreground">No hay ECNs que coincidan con los filtros</p><p className="mt-1 text-sm text-muted-foreground">Seleccione otro estatus o ajuste la búsqueda para consultar los demás cambios de esta familia.</p></td></tr>}
                        </tbody>
                    </table>
                </div>
                <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-muted-foreground">Los demás estatus se muestran únicamente al seleccionarlos en el filtro.</p><Button variant="secondary" onClick={() => setSelectedFamily(null)}>Cerrar ventana</Button></div>
                </div>
            </Modal>

            <EcnDetailModal 
                isOpen={isDetailModalOpen} 
                onClose={() => setIsDetailModalOpen(false)} 
                ecn={selectedEcn} 
                onRegenerateSummary={(id) => handleGenerateSummary(id, true)}
                isGeneratingSummary={isGeneratingSummary === selectedEcn?.id}
            />
            <EcnNotesModal isOpen={isNotesModalOpen} onClose={() => setIsNotesModalOpen(false)} ecn={selectedEcn} onNoteAdded={handleNoteAdded} users={users} />
            <DescriptionModal 
                isOpen={descriptionModal.isOpen} 
                onClose={() => setDescriptionModal({ isOpen: false, content: '', title: ''})}
                description={descriptionModal.content}
                title={descriptionModal.title}
            />
        </div>
    );
};

export default Dashboard;
