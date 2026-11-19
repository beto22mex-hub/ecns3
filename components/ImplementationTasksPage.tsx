import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { ImplementationTask, User, ECN } from '../types';
import * as api from '../services/api';
import { Card, Button, Toast, Pagination } from './ui';

interface ImplementationTasksPageProps {
    users: User[];
}

interface EcnAutocompleteProps {
    value: string;
    onChange: (ecnId: string, selectedEcn?: ECN) => void;
    ecns: ECN[];
    placeholder?: string;
    required?: boolean;
    disabled?: boolean;
}

const EcnAutocomplete: React.FC<EcnAutocompleteProps> = ({
    value,
    onChange,
    ecns,
    placeholder = 'Buscar o escribir ECN (ej. 2025-1042)...',
    required = false,
    disabled = false
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState(-1);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const filteredEcns = useMemo(() => {
        if (!value.trim()) {
            return ecns.slice(0, 8);
        }
        const query = value.toLowerCase().trim();
        return ecns.filter(e =>
            (e.id && e.id.toLowerCase().includes(query)) ||
            (e.description && e.description.toLowerCase().includes(query)) ||
            (e.familyList && e.familyList.toLowerCase().includes(query)) ||
            (e.initiator && e.initiator.toLowerCase().includes(query))
        ).slice(0, 10);
    }, [ecns, value]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleSelect = (ecn: ECN) => {
        onChange(ecn.id, ecn);
        setIsOpen(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!isOpen) {
            if (e.key === 'ArrowDown' || e.key === 'Enter') {
                setIsOpen(true);
            }
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlightedIndex(prev => (prev < filteredEcns.length - 1 ? prev + 1 : 0));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlightedIndex(prev => (prev > 0 ? prev - 1 : filteredEcns.length - 1));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (highlightedIndex >= 0 && highlightedIndex < filteredEcns.length) {
                handleSelect(filteredEcns[highlightedIndex]);
            } else {
                setIsOpen(false);
            }
        } else if (e.key === 'Escape') {
            setIsOpen(false);
        }
    };

    return (
        <div ref={containerRef} className="relative w-full">
            <div className="relative">
                <input
                    ref={inputRef}
                    type="text"
                    value={value}
                    onChange={(e) => {
                        onChange(e.target.value);
                        setIsOpen(true);
                        setHighlightedIndex(-1);
                    }}
                    onFocus={() => setIsOpen(true)}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    required={required}
                    disabled={disabled}
                    autoComplete="off"
                    className="w-full pl-9 pr-8 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono font-medium"
                />
                <svg className="w-4 h-4 text-muted-foreground absolute left-3 top-3 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>

                {value && (
                    <button
                        type="button"
                        onClick={() => {
                            onChange('');
                            setIsOpen(true);
                            inputRef.current?.focus();
                        }}
                        className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground p-0.5 rounded-full hover:bg-muted"
                        title="Limpiar campo"
                    >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                )}
            </div>

            {isOpen && (
                <div className="absolute z-50 left-0 right-0 mt-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-card shadow-2xl text-sm animate-in fade-in zoom-in-95 duration-100">
                    {filteredEcns.length > 0 ? (
                        <div className="py-1">
                            <div className="px-3 py-1.5 text-[11px] font-semibold uppercase text-muted-foreground bg-muted/40 border-b border-border/50 flex justify-between items-center">
                                <span>ECNs coincidentes</span>
                                <span>{filteredEcns.length} encontrada{filteredEcns.length > 1 ? 's' : ''}</span>
                            </div>
                            {filteredEcns.map((ecn, idx) => (
                                <div
                                    key={ecn.id}
                                    onClick={() => handleSelect(ecn)}
                                    onMouseEnter={() => setHighlightedIndex(idx)}
                                    className={`px-3 py-2 cursor-pointer transition-colors border-b border-border/30 last:border-b-0 ${
                                        idx === highlightedIndex ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50 text-foreground'
                                    }`}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="font-mono font-bold text-sm text-primary">
                                            {ecn.id}
                                        </span>
                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                            ecn.status === 'Implementado' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' :
                                            ecn.status === 'Implementado Parcial' ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' :
                                            ecn.status === 'Cancelado' ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' :
                                            'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                        }`}>
                                            {ecn.status}
                                        </span>
                                    </div>
                                    {ecn.description && (
                                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                                            {ecn.description}
                                        </p>
                                    )}
                                    {ecn.familyList && (
                                        <div className="text-[10px] text-muted-foreground/80 mt-0.5 flex items-center gap-1">
                                            <span className="font-medium text-foreground/70">Familia:</span> {ecn.familyList}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="p-3 text-xs text-center text-muted-foreground">
                            <span>No se encontró ningún ECN registrado con ese término.</span>
                            {value.trim() && (
                                <div className="mt-1 font-medium text-primary">
                                    Presione Enter o continúe para usar "{value.trim()}" como ECN manual.
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const COMMON_DEPARTMENTS = [
    'Planeación (Compras)',
    'Planeación (Producción)',
    'Finanzas',
    'Materiales',
    'Ingeniería de Manufactura',
    'Ingeniería de Calidad',
    'Ingeniería de Producto',
    'Operaciones / Producción',
    'Sistemas / TI'
];

export const SUGGESTED_TASKS = [
    { department: 'Planeación (Compras)', taskName: 'Asignar Fecha de Llegada de Nuevo Material', icon: '🛒' },
    { department: 'Planeación (Producción)', taskName: 'Refrescar Órdenes de Producción', icon: '🏭' },
    { department: 'Finanzas', taskName: 'Costeo de Materiales', icon: '💰' },
    { department: 'Materiales', taskName: 'Agregar Material a Listado de Scrap', icon: '📦' },
    { department: 'Ingeniería de Manufactura', taskName: 'Creación / Actualización de Instrucciones de Trabajo', icon: '📐' },
    { department: 'Ingeniería de Calidad', taskName: 'Validación de Calidad / Primera Pieza', icon: '🔍' },
    { department: 'Ingeniería de Producto', taskName: 'Validación de Muestras e Ingeniería', icon: '🔬' }
];

interface NewTaskState {
    ecnId: string;
    family: string;
    department: string;
    customDepartment: string;
    taskName: string;
    assignedUserId: string;
    status: 'Pendiente' | 'En Proceso' | 'Completado' | 'Cancelado';
    dueDate: string;
    comments: string;
}

const initialNewTaskState: NewTaskState = {
    ecnId: '',
    family: '',
    department: 'Planeación (Compras)',
    customDepartment: '',
    taskName: '',
    assignedUserId: '',
    status: 'Pendiente',
    dueDate: '',
    comments: ''
};

export const ImplementationTasksPage: React.FC<ImplementationTasksPageProps> = ({ users }) => {
    const [tasks, setTasks] = useState<ImplementationTask[]>([]);
    const [ecns, setEcns] = useState<ECN[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

    // Filters
    const [familyFilter, setFamilyFilter] = useState('Todas');
    const [departmentFilter, setDepartmentFilter] = useState('Todos');
    const [statusFilter, setStatusFilter] = useState('Todos');
    const [userFilter, setUserFilter] = useState('Todos');
    const [search, setSearch] = useState('');

    // Pagination
    const [currentPage, setCurrentPage] = useState(1);
    const [pageSize, setPageSize] = useState(50);

    // Modal states
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [isBatchSuggestionsModalOpen, setIsBatchSuggestionsModalOpen] = useState(false);
    const [batchEcnId, setBatchEcnId] = useState('');
    const [batchFamily, setBatchFamily] = useState('');
    const [batchAssignedUserId, setBatchAssignedUserId] = useState('');
    const [batchDueDate, setBatchDueDate] = useState('');
    const [selectedSuggestedTaskIndices, setSelectedSuggestedTaskIndices] = useState<number[]>([0, 1, 2, 3, 4]);
    const [newTask, setNewTask] = useState<NewTaskState>(initialNewTaskState);
    const [editingTask, setEditingTask] = useState<ImplementationTask | null>(null);
    const [deletingTask, setDeletingTask] = useState<ImplementationTask | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    const fetchTasks = useCallback(async () => {
        setIsLoading(true);
        try {
            const data = await api.getImplementationTasks();
            setTasks(Array.isArray(data) ? data : []);
        } catch (error) {
            console.error("Failed to fetch implementation tasks", error);
            setNotification({ message: 'Error al cargar las tareas de implementación.', type: 'error' });
        } finally {
            setIsLoading(false);
        }
    }, []);

    const fetchEcns = useCallback(async () => {
        try {
            const data = await api.getEcns();
            setEcns(Array.isArray(data) ? data : []);
        } catch (error) {
            console.warn("Could not load ECN list for task selection:", error);
        }
    }, []);

    useEffect(() => {
        fetchTasks();
        fetchEcns();
    }, [fetchTasks, fetchEcns]);

    const uniqueFamilies = useMemo(() => {
        const set = new Set<string>();
        tasks.forEach(t => { if (t.family) set.add(t.family); });
        ecns.forEach(e => {
            if (e.familyList) {
                e.familyList.split(',').forEach(f => {
                    const trimmed = f.trim();
                    if (trimmed && trimmed !== 'Sin Familia') set.add(trimmed);
                });
            }
        });
        return Array.from(set).sort();
    }, [tasks, ecns]);

    const uniqueDepartments = useMemo(() => {
        const set = new Set<string>(COMMON_DEPARTMENTS);
        tasks.forEach(t => { if (t.department) set.add(t.department); });
        return Array.from(set).sort();
    }, [tasks]);

    const filteredTasks = useMemo(() => {
        return tasks.filter(t => {
            if (familyFilter !== 'Todas' && t.family !== familyFilter) return false;
            if (departmentFilter !== 'Todos' && t.department !== departmentFilter) return false;
            if (statusFilter !== 'Todos' && t.status !== statusFilter) return false;
            if (userFilter !== 'Todos' && t.assignedUserId !== userFilter) return false;

            if (search.trim()) {
                const q = search.toLowerCase();
                const match = 
                    (t.ecnId && t.ecnId.toLowerCase().includes(q)) ||
                    (t.taskName && t.taskName.toLowerCase().includes(q)) ||
                    (t.family && t.family.toLowerCase().includes(q)) ||
                    (t.department && t.department.toLowerCase().includes(q)) ||
                    (t.comments && t.comments.toLowerCase().includes(q)) ||
                    (t.assignedUserName && t.assignedUserName.toLowerCase().includes(q));
                if (!match) return false;
            }

            return true;
        });
    }, [tasks, familyFilter, departmentFilter, statusFilter, userFilter, search]);

    useEffect(() => {
        setCurrentPage(1);
    }, [familyFilter, departmentFilter, statusFilter, userFilter, search]);

    const totalPages = useMemo(() => {
        return Math.max(1, Math.ceil(filteredTasks.length / pageSize));
    }, [filteredTasks.length, pageSize]);

    const paginatedTasks = useMemo(() => {
        const start = (currentPage - 1) * pageSize;
        return filteredTasks.slice(start, start + pageSize);
    }, [filteredTasks, currentPage, pageSize]);

    const taskCounts = useMemo(() => {
        const res = { total: tasks.length, pendiente: 0, enProceso: 0, completado: 0, cancelado: 0 };
        tasks.forEach(t => {
            if (t.status === 'Pendiente') res.pendiente++;
            else if (t.status === 'En Proceso') res.enProceso++;
            else if (t.status === 'Completado') res.completado++;
            else if (t.status === 'Cancelado') res.cancelado++;
        });
        return res;
    }, [tasks]);

    const handleSelectEcnForNewTask = (ecnId: string, found?: ECN) => {
        const ecnObj = found || ecns.find(e => e.id.toLowerCase() === ecnId.toLowerCase());
        let suggestedFamily = '';
        if (ecnObj && ecnObj.familyList) {
            const firstFam = ecnObj.familyList.split(',')[0].trim();
            if (firstFam && firstFam !== 'Sin Familia') {
                suggestedFamily = firstFam;
            }
        }
        setNewTask(prev => ({
            ...prev,
            ecnId,
            family: suggestedFamily || prev.family
        }));
    };

    const handleSelectEcnForEditingTask = (ecnId: string, found?: ECN) => {
        if (!editingTask) return;
        const ecnObj = found || ecns.find(e => e.id.toLowerCase() === ecnId.toLowerCase());
        let suggestedFamily = '';
        if (ecnObj && ecnObj.familyList) {
            const firstFam = ecnObj.familyList.split(',')[0].trim();
            if (firstFam && firstFam !== 'Sin Familia') {
                suggestedFamily = firstFam;
            }
        }
        setEditingTask(prev => prev ? ({
            ...prev,
            ecnId,
            family: suggestedFamily || prev.family
        }) : null);
    };

    const handleSelectEcnForBatch = (ecnId: string, found?: ECN) => {
        const ecnObj = found || ecns.find(e => e.id.toLowerCase() === ecnId.toLowerCase());
        let suggestedFamily = '';
        if (ecnObj && ecnObj.familyList) {
            const firstFam = ecnObj.familyList.split(',')[0].trim();
            if (firstFam && firstFam !== 'Sin Familia') {
                suggestedFamily = firstFam;
            }
        }
        setBatchEcnId(ecnId);
        setBatchFamily(suggestedFamily || batchFamily);
    };

    const handleCreateBatchTasks = async () => {
        if (!batchEcnId.trim()) {
            setNotification({ message: 'Por favor indique o busque el número de ECN para asociar las tareas.', type: 'error' });
            return;
        }
        if (selectedSuggestedTaskIndices.length === 0) {
            setNotification({ message: 'Seleccione al menos una tarea sugerida para crear.', type: 'error' });
            return;
        }

        setIsSaving(true);
        try {
            for (const idx of selectedSuggestedTaskIndices) {
                const item = SUGGESTED_TASKS[idx];
                await api.createImplementationTask({
                    ecnId: batchEcnId.trim(),
                    family: batchFamily.trim() || 'General',
                    department: item.department,
                    taskName: item.taskName,
                    assignedUserId: batchAssignedUserId || undefined,
                    status: 'Pendiente',
                    dueDate: batchDueDate || undefined,
                    comments: 'Tarea sugerida agregada manualmente'
                });
            }

            setNotification({
                message: `Se crearon exitosamente ${selectedSuggestedTaskIndices.length} tareas sugeridas para el ECN ${batchEcnId.trim()}.`,
                type: 'success'
            });
            setIsBatchSuggestionsModalOpen(false);
            setBatchEcnId('');
            setBatchFamily('');
            setBatchAssignedUserId('');
            setBatchDueDate('');
            await fetchTasks();
        } catch (error: any) {
            console.error("Failed to create batch tasks", error);
            setNotification({ message: error.message || 'Error al crear las tareas sugeridas.', type: 'error' });
        } finally {
            setIsSaving(false);
        }
    };

    const handleCreateTask = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        const finalEcnId = newTask.ecnId.trim();
        const finalTaskName = newTask.taskName.trim();
        const finalDept = newTask.department === 'Otro' ? newTask.customDepartment.trim() : newTask.department.trim();

        if (!finalEcnId) {
            setNotification({ message: 'Por favor indique o seleccione el número de ECN.', type: 'error' });
            return;
        }
        if (!finalTaskName) {
            setNotification({ message: 'El nombre o descripción de la tarea es obligatorio.', type: 'error' });
            return;
        }
        if (!finalDept) {
            setNotification({ message: 'Por favor indique el departamento responsable.', type: 'error' });
            return;
        }

        setIsSaving(true);
        try {
            await api.createImplementationTask({
                ecnId: finalEcnId,
                family: newTask.family.trim() || 'General',
                department: finalDept,
                taskName: finalTaskName,
                assignedUserId: newTask.assignedUserId || undefined,
                status: newTask.status,
                dueDate: newTask.dueDate || undefined,
                comments: newTask.comments.trim()
            });

            setNotification({ message: 'Nueva tarea creada exitosamente.', type: 'success' });
            setIsCreateModalOpen(false);
            setNewTask(initialNewTaskState);
            await fetchTasks();
        } catch (error: any) {
            console.error("Failed to create task", error);
            setNotification({ message: error.message || 'Error al crear la tarea de implementación.', type: 'error' });
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveEditingTask = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        if (!editingTask) return;
        if (!editingTask.taskName.trim()) {
            setNotification({ message: 'El nombre de la tarea no puede estar vacío.', type: 'error' });
            return;
        }
        if (!editingTask.ecnId.trim()) {
            setNotification({ message: 'El número de ECN es obligatorio.', type: 'error' });
            return;
        }

        setIsSaving(true);
        try {
            await api.updateImplementationTask(editingTask.id, {
                ecnId: editingTask.ecnId.trim(),
                family: editingTask.family ? editingTask.family.trim() : 'General',
                department: editingTask.department ? editingTask.department.trim() : 'General',
                taskName: editingTask.taskName.trim(),
                status: editingTask.status,
                assignedUserId: editingTask.assignedUserId || '',
                dueDate: editingTask.dueDate || '',
                comments: editingTask.comments || ''
            });

            setNotification({ message: 'Tarea actualizada correctamente.', type: 'success' });
            setEditingTask(null);
            await fetchTasks();
        } catch (error: any) {
            console.error("Failed to update task", error);
            setNotification({ message: error.message || 'Error al actualizar la tarea.', type: 'error' });
        } finally {
            setIsSaving(false);
        }
    };

    const handleDeleteTask = async () => {
        if (!deletingTask) return;
        setIsDeleting(true);
        try {
            await api.deleteImplementationTask(deletingTask.id);
            setNotification({ message: 'Tarea eliminada correctamente.', type: 'success' });
            setDeletingTask(null);
            await fetchTasks();
        } catch (error: any) {
            console.error("Failed to delete task", error);
            setNotification({ message: error.message || 'Error al eliminar la tarea.', type: 'error' });
        } finally {
            setIsDeleting(false);
        }
    };

    const handleExportExcel = () => {
        if (filteredTasks.length === 0) {
            setNotification({ message: 'No hay tareas para exportar.', type: 'error' });
            return;
        }
        const dataToExport = filteredTasks.map(t => ({
            'ECN': t.ecnId,
            'FAMILIA DE PRODUCTO': t.family,
            'DEPARTAMENTO': t.department,
            'TAREA DE IMPLEMENTACIÓN': t.taskName,
            'RESPONSABLE ASIGNADO': t.assignedUserName || users.find(u => u.id === t.assignedUserId)?.name || t.assignedUserId || 'Sin asignar',
            'ESTATUS': t.status,
            'FECHA VENCIMIENTO': t.dueDate ? t.dueDate.split('T')[0] : '',
            'COMENTARIOS': t.comments || ''
        }));

        const worksheet = XLSX.utils.json_to_sheet(dataToExport);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Tareas_Implementacion');
        XLSX.writeFile(workbook, `Tareas_Implementacion_${new Date().toISOString().split('T')[0]}.xlsx`);
        setNotification({ message: 'Reporte de tareas exportado a Excel con éxito.', type: 'success' });
    };

    const isOverdue = (dueDateStr?: string, status?: string) => {
        if (!dueDateStr || status === 'Completado' || status === 'Cancelado') return false;
        try {
            const due = new Date(dueDateStr.split('T')[0] + 'T23:59:59');
            return due.getTime() < Date.now();
        } catch {
            return false;
        }
    };

    return (
        <div className="space-y-6">
            {notification && <Toast message={notification.message} type={notification.type} onClose={() => setNotification(null)} />}

            {/* Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
                        <svg className="w-7 h-7 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                        </svg>
                        Sistema de Tareas de Implementación por Departamento y Familia
                    </h1>
                    <p className="text-sm text-muted-foreground mt-1">
                        Control total CRUD (crear, consultar, actualizar y eliminar) de tareas de implementación ligadas a ECNs, familias y departamentos operativos.
                    </p>
                </div>
                <div className="flex items-center gap-2.5 flex-wrap">
                    <Button variant="primary" onClick={() => { setNewTask(initialNewTaskState); setIsCreateModalOpen(true); }} className="flex items-center gap-1.5 shadow-sm">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                        </svg>
                        Nueva Tarea
                    </Button>
                    <Button variant="secondary" onClick={handleExportExcel} className="flex items-center gap-1.5">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Exportar Excel
                    </Button>
                    <Button onClick={fetchTasks} variant="secondary" className="flex items-center gap-1.5" title="Recargar lista">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Actualizar
                    </Button>
                </div>
            </div>

            {/* Metrics cards */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3.5">
                <Card className="!p-4 bg-card border border-border">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Total Tareas</p>
                    <p className="text-2xl sm:text-3xl font-bold text-foreground mt-1">{taskCounts.total}</p>
                </Card>
                <Card className="!p-4 bg-amber-500/10 border border-amber-500/20">
                    <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide">Pendientes</p>
                    <p className="text-2xl sm:text-3xl font-bold text-amber-700 dark:text-amber-300 mt-1">{taskCounts.pendiente}</p>
                </Card>
                <Card className="!p-4 bg-sky-500/10 border border-sky-500/20">
                    <p className="text-xs font-semibold text-sky-600 dark:text-sky-400 uppercase tracking-wide">En Proceso</p>
                    <p className="text-2xl sm:text-3xl font-bold text-sky-700 dark:text-sky-300 mt-1">{taskCounts.enProceso}</p>
                </Card>
                <Card className="!p-4 bg-emerald-500/10 border border-emerald-500/20">
                    <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">Completadas</p>
                    <p className="text-2xl sm:text-3xl font-bold text-emerald-700 dark:text-emerald-300 mt-1">{taskCounts.completado}</p>
                </Card>
                <Card className="!p-4 bg-muted border border-border">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Canceladas</p>
                    <p className="text-2xl sm:text-3xl font-bold text-muted-foreground mt-1">{taskCounts.cancelado}</p>
                </Card>
            </div>

            {/* Filters toolbar */}
            <Card className="!p-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Familia de Producto</label>
                        <select
                            value={familyFilter}
                            onChange={(e) => setFamilyFilter(e.target.value)}
                            className="w-full px-3 py-1.5 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                            <option value="Todas">Todas las familias ({uniqueFamilies.length})</option>
                            {uniqueFamilies.map(f => <option key={f} value={f}>{f}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Departamento</label>
                        <select
                            value={departmentFilter}
                            onChange={(e) => setDepartmentFilter(e.target.value)}
                            className="w-full px-3 py-1.5 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                            <option value="Todos">Todos los departamentos</option>
                            {uniqueDepartments.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Estatus</label>
                        <select
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value)}
                            className="w-full px-3 py-1.5 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                            <option value="Todos">Todos los estatus</option>
                            <option value="Pendiente">Pendiente</option>
                            <option value="En Proceso">En Proceso</option>
                            <option value="Completado">Completado</option>
                            <option value="Cancelado">Cancelado</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Responsable</label>
                        <select
                            value={userFilter}
                            onChange={(e) => setUserFilter(e.target.value)}
                            className="w-full px-3 py-1.5 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                            <option value="Todos">Todos los usuarios</option>
                            {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.department || 'General'})</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Búsqueda General</label>
                        <div className="relative">
                            <input
                                type="text"
                                placeholder="Buscar ECN, tarea, notas..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                className="w-full pl-8 pr-3 py-1.5 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                            />
                            <svg className="w-4 h-4 text-muted-foreground absolute left-2.5 top-2.5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                        </div>
                    </div>
                </div>

                {(familyFilter !== 'Todas' || departmentFilter !== 'Todos' || statusFilter !== 'Todos' || userFilter !== 'Todos' || search) && (
                    <div className="flex items-center justify-between mt-3 pt-2 border-t border-border text-xs text-muted-foreground">
                        <span>Mostrando <strong>{filteredTasks.length}</strong> de <strong>{tasks.length}</strong> tareas</span>
                        <button
                            onClick={() => { setFamilyFilter('Todas'); setDepartmentFilter('Todos'); setStatusFilter('Todos'); setUserFilter('Todos'); setSearch(''); }}
                            className="text-primary hover:underline font-medium"
                        >
                            Limpiar filtros
                        </button>
                    </div>
                )}
            </Card>

            {/* Table */}
            <div className="overflow-x-auto border border-border rounded-xl shadow-sm bg-card">
                <table className="min-w-full divide-y divide-border">
                    <thead className="bg-muted/60">
                        <tr>
                            <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">ECN</th>
                            <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Familia</th>
                            <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Departamento</th>
                            <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tarea de Implementación</th>
                            <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Responsable</th>
                            <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Estatus</th>
                            <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Vencimiento</th>
                            <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Acciones</th>
                        </tr>
                    </thead>
                    <tbody className="bg-card divide-y divide-border">
                        {isLoading ? (
                            <tr>
                                <td colSpan={8} className="text-center py-12 text-muted-foreground">
                                    <div className="inline-flex items-center gap-2">
                                        <svg className="animate-spin h-5 w-5 text-primary" viewBox="0 0 24 24" fill="none">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                                        </svg>
                                        Cargando tareas de implementación...
                                    </div>
                                </td>
                            </tr>
                        ) : filteredTasks.length > 0 ? (
                            paginatedTasks.map(task => {
                                const overdue = isOverdue(task.dueDate, task.status);
                                return (
                                    <tr key={task.id} className="hover:bg-muted/40 transition-colors">
                                        <td className="px-4 py-3 whitespace-nowrap text-sm font-bold font-mono text-primary">
                                            {task.ecnId}
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap text-sm text-foreground">
                                            <span className="bg-secondary/80 text-secondary-foreground border border-border/50 px-2 py-0.5 rounded text-xs font-medium">
                                                {task.family || 'General'}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-foreground">
                                            {task.department}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-foreground font-medium max-w-sm">
                                            <div className="truncate font-semibold" title={task.taskName}>{task.taskName}</div>
                                            {task.comments && (
                                                <div className="text-xs text-muted-foreground truncate mt-0.5 flex items-center gap-1" title={task.comments}>
                                                    <span className="text-primary/70">💬</span> {task.comments}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap text-sm text-muted-foreground">
                                            {task.assignedUserName || users.find(u => u.id === task.assignedUserId)?.name ? (
                                                <div className="flex items-center gap-1.5">
                                                    <div className="w-6 h-6 rounded-full bg-primary/10 text-primary font-bold text-[10px] flex items-center justify-center">
                                                        {(task.assignedUserName || users.find(u => u.id === task.assignedUserId)?.name || 'U').charAt(0).toUpperCase()}
                                                    </div>
                                                    <span>{task.assignedUserName || users.find(u => u.id === task.assignedUserId)?.name}</span>
                                                </div>
                                            ) : (
                                                <span className="text-amber-500 italic text-xs">Sin asignar</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap text-sm">
                                            <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                                                task.status === 'Completado' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20' :
                                                task.status === 'En Proceso' ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/20' :
                                                task.status === 'Cancelado' ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/20' :
                                                'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/20'
                                            }`}>
                                                {task.status === 'Completado' && '✓'}
                                                {task.status === 'En Proceso' && '●'}
                                                {task.status === 'Pendiente' && '⏳'}
                                                {task.status === 'Cancelado' && '✕'}
                                                {' '}{task.status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap text-sm text-muted-foreground font-mono">
                                            {task.dueDate ? (
                                                <div className="flex items-center gap-1">
                                                    <span>{task.dueDate.split('T')[0]}</span>
                                                    {overdue && (
                                                        <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-rose-500/20 text-rose-600 dark:text-rose-400 border border-rose-500/30">
                                                            Vencida
                                                        </span>
                                                    )}
                                                </div>
                                            ) : (
                                                <span className="text-muted-foreground/60">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap text-right text-sm font-medium">
                                            <div className="flex items-center justify-end gap-1.5">
                                                <button
                                                    onClick={() => setEditingTask({ ...task })}
                                                    className="px-2.5 py-1 text-xs rounded bg-secondary hover:bg-secondary/80 text-secondary-foreground font-medium transition-colors"
                                                    title="Editar tarea"
                                                >
                                                    Editar
                                                </button>
                                                <button
                                                    onClick={() => setDeletingTask(task)}
                                                    className="px-2.5 py-1 text-xs rounded bg-destructive/10 hover:bg-destructive/20 text-destructive font-medium transition-colors"
                                                    title="Eliminar tarea"
                                                >
                                                    Eliminar
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })
                        ) : (
                            <tr>
                                <td colSpan={8} className="text-center py-12 text-muted-foreground">
                                    <div className="flex flex-col items-center justify-center gap-2">
                                        <svg className="w-10 h-10 text-muted-foreground/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                                        </svg>
                                        <p>No se encontraron tareas con los filtros seleccionados.</p>
                                        <Button variant="secondary" onClick={() => { setNewTask(initialNewTaskState); setIsCreateModalOpen(true); }} className="mt-2 text-xs">
                                            + Crear Nueva Tarea
                                        </Button>
                                    </div>
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Pagination Controls */}
            {filteredTasks.length > 0 && (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-2 py-1 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span>
                            Mostrando <strong>{Math.min((currentPage - 1) * pageSize + 1, filteredTasks.length)}</strong> a <strong>{Math.min(currentPage * pageSize, filteredTasks.length)}</strong> de <strong>{filteredTasks.length}</strong> tareas
                        </span>
                        <span className="text-muted-foreground/40">•</span>
                        <div className="flex items-center gap-1.5">
                            <span className="text-xs">Por página:</span>
                            <select
                                value={pageSize}
                                onChange={(e) => {
                                    setPageSize(Number(e.target.value));
                                    setCurrentPage(1);
                                }}
                                className="px-2 py-0.5 border border-input rounded text-xs bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                            >
                                <option value={25}>25</option>
                                <option value={50}>50</option>
                                <option value={100}>100</option>
                                <option value={200}>200</option>
                            </select>
                        </div>
                    </div>

                    <Pagination
                        currentPage={currentPage}
                        totalPages={totalPages}
                        onPageChange={setCurrentPage}
                    />
                </div>
            )}

            {/* Modal: CREAR NUEVA TAREA */}
            {isCreateModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                    <div className="bg-card border border-border rounded-xl shadow-2xl max-w-lg w-full p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto">
                        <div className="flex justify-between items-center pb-2 border-b border-border">
                            <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                                <span className="p-1.5 rounded-md bg-primary/10 text-primary">
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                                    </svg>
                                </span>
                                Crear Nueva Tarea de Implementación
                            </h3>
                            <button
                                onClick={() => setIsCreateModalOpen(false)}
                                className="text-muted-foreground hover:text-foreground p-1 rounded-md"
                            >
                                ✕
                            </button>
                        </div>

                        <form onSubmit={handleCreateTask} className="space-y-3.5 text-sm">
                            {/* ECN Autocomplete */}
                            <div>
                                <label className="block text-xs font-semibold text-foreground mb-1">
                                    ECN Asociado <span className="text-destructive">*</span>
                                </label>
                                <EcnAutocomplete
                                    value={newTask.ecnId}
                                    onChange={handleSelectEcnForNewTask}
                                    ecns={ecns}
                                    placeholder="Buscar o escribir ECN (ej. 2025-1042)..."
                                    required
                                />
                                <span className="text-[11px] text-muted-foreground mt-1 block">
                                    Escriba para autocompletar por código, descripción o familia.
                                </span>
                            </div>

                            {/* Tarea Name */}
                            <div>
                                <label className="block text-xs font-semibold text-foreground mb-1">
                                    Nombre o Descripción de la Tarea <span className="text-destructive">*</span>
                                </label>
                                <input
                                    type="text"
                                    placeholder="ej. Asignar fecha de llegada de nuevo material en SAP"
                                    value={newTask.taskName}
                                    onChange={(e) => setNewTask({ ...newTask, taskName: e.target.value })}
                                    required
                                    className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                />
                            </div>

                            {/* Familia & Departamento */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-semibold text-foreground mb-1">
                                        Familia de Producto
                                    </label>
                                    <input
                                        type="text"
                                        list="available-families"
                                        placeholder="ej. VESDA LaserPlus"
                                        value={newTask.family}
                                        onChange={(e) => setNewTask({ ...newTask, family: e.target.value })}
                                        className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                    />
                                    <datalist id="available-families">
                                        {uniqueFamilies.map(f => <option key={f} value={f} />)}
                                    </datalist>
                                </div>

                                <div>
                                    <label className="block text-xs font-semibold text-foreground mb-1">
                                        Departamento Responsable <span className="text-destructive">*</span>
                                    </label>
                                    <select
                                        value={newTask.department}
                                        onChange={(e) => setNewTask({ ...newTask, department: e.target.value })}
                                        className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                    >
                                        {uniqueDepartments.map(d => (
                                            <option key={d} value={d}>{d}</option>
                                        ))}
                                        <option value="Otro">Otro (especificar)...</option>
                                    </select>
                                    {newTask.department === 'Otro' && (
                                        <input
                                            type="text"
                                            placeholder="Nombre del departamento..."
                                            value={newTask.customDepartment}
                                            onChange={(e) => setNewTask({ ...newTask, customDepartment: e.target.value })}
                                            className="w-full mt-1.5 px-3 py-1.5 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                            required
                                        />
                                    )}
                                </div>
                            </div>

                            {/* Responsable & Estatus */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-semibold text-foreground mb-1">
                                        Responsable Asignado
                                    </label>
                                    <select
                                        value={newTask.assignedUserId}
                                        onChange={(e) => setNewTask({ ...newTask, assignedUserId: e.target.value })}
                                        className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                    >
                                        <option value="">Sin asignar</option>
                                        {users.map(u => (
                                            <option key={u.id} value={u.id}>
                                                {u.name} — {u.department || 'General'}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div>
                                    <label className="block text-xs font-semibold text-foreground mb-1">
                                        Estatus Inicial
                                    </label>
                                    <select
                                        value={newTask.status}
                                        onChange={(e) => setNewTask({ ...newTask, status: e.target.value as any })}
                                        className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                    >
                                        <option value="Pendiente">Pendiente</option>
                                        <option value="En Proceso">En Proceso</option>
                                        <option value="Completado">Completado</option>
                                        <option value="Cancelado">Cancelado</option>
                                    </select>
                                </div>
                            </div>

                            {/* Fecha de vencimiento */}
                            <div>
                                <label className="block text-xs font-semibold text-foreground mb-1">
                                    Fecha de Vencimiento
                                </label>
                                <input
                                    type="date"
                                    value={newTask.dueDate}
                                    onChange={(e) => setNewTask({ ...newTask, dueDate: e.target.value })}
                                    className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                />
                            </div>

                            {/* Comentarios / notas */}
                            <div>
                                <label className="block text-xs font-semibold text-foreground mb-1">
                                    Comentarios / Instrucciones Iniciales
                                </label>
                                <textarea
                                    rows={2}
                                    value={newTask.comments}
                                    onChange={(e) => setNewTask({ ...newTask, comments: e.target.value })}
                                    className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                    placeholder="Notas adicionales o instrucciones para el responsable..."
                                />
                            </div>

                            {/* Actions */}
                            <div className="flex justify-end gap-3 pt-4 border-t border-border">
                                <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={() => setIsCreateModalOpen(false)}
                                    disabled={isSaving}
                                >
                                    Cancelar
                                </Button>
                                <Button
                                    type="submit"
                                    variant="primary"
                                    disabled={isSaving}
                                >
                                    {isSaving ? 'Creando tarea...' : 'Crear Tarea'}
                                </Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Modal: EDITAR TAREA (Full CRUD edit) */}
            {editingTask && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                    <div className="bg-card border border-border rounded-xl shadow-2xl max-w-lg w-full p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto">
                        <div className="flex justify-between items-center pb-2 border-b border-border">
                            <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                                <span className="p-1.5 rounded-md bg-secondary text-secondary-foreground">
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                    </svg>
                                </span>
                                Editar Tarea de Implementación
                            </h3>
                            <button
                                onClick={() => setEditingTask(null)}
                                className="text-muted-foreground hover:text-foreground p-1 rounded-md"
                            >
                                ✕
                            </button>
                        </div>

                        <form onSubmit={handleSaveEditingTask} className="space-y-3.5 text-sm">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-semibold text-foreground mb-1">
                                        ECN Asociado <span className="text-destructive">*</span>
                                    </label>
                                    <EcnAutocomplete
                                        value={editingTask.ecnId}
                                        onChange={handleSelectEcnForEditingTask}
                                        ecns={ecns}
                                        placeholder="Buscar o escribir ECN..."
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold text-foreground mb-1">
                                        Familia de Producto
                                    </label>
                                    <input
                                        type="text"
                                        list="available-families-edit"
                                        value={editingTask.family || ''}
                                        onChange={(e) => setEditingTask({ ...editingTask, family: e.target.value })}
                                        className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                    />
                                    <datalist id="available-families-edit">
                                        {uniqueFamilies.map(f => <option key={f} value={f} />)}
                                    </datalist>
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-foreground mb-1">
                                    Departamento <span className="text-destructive">*</span>
                                </label>
                                <input
                                    type="text"
                                    list="available-departments-edit"
                                    value={editingTask.department || ''}
                                    onChange={(e) => setEditingTask({ ...editingTask, department: e.target.value })}
                                    required
                                    className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                />
                                <datalist id="available-departments-edit">
                                    {uniqueDepartments.map(d => <option key={d} value={d} />)}
                                </datalist>
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-foreground mb-1">
                                    Nombre o Detalle de la Tarea <span className="text-destructive">*</span>
                                </label>
                                <input
                                    type="text"
                                    value={editingTask.taskName}
                                    onChange={(e) => setEditingTask({ ...editingTask, taskName: e.target.value })}
                                    required
                                    className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                />
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-semibold text-foreground mb-1">Estatus</label>
                                    <select
                                        value={editingTask.status}
                                        onChange={(e) => setEditingTask({ ...editingTask, status: e.target.value as any })}
                                        className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring font-medium"
                                    >
                                        <option value="Pendiente">Pendiente</option>
                                        <option value="En Proceso">En Proceso</option>
                                        <option value="Completado">Completado</option>
                                        <option value="Cancelado">Cancelado</option>
                                    </select>
                                </div>

                                <div>
                                    <label className="block text-xs font-semibold text-foreground mb-1">Responsable Asignado</label>
                                    <select
                                        value={editingTask.assignedUserId || ''}
                                        onChange={(e) => setEditingTask({ ...editingTask, assignedUserId: e.target.value })}
                                        className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                    >
                                        <option value="">Sin asignar</option>
                                        {users.map(u => (
                                            <option key={u.id} value={u.id}>
                                                {u.name} — {u.department || 'General'}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-foreground mb-1">Fecha de Vencimiento</label>
                                <input
                                    type="date"
                                    value={editingTask.dueDate ? editingTask.dueDate.split('T')[0] : ''}
                                    onChange={(e) => setEditingTask({ ...editingTask, dueDate: e.target.value })}
                                    className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-foreground mb-1">Comentarios / Notas</label>
                                <textarea
                                    rows={3}
                                    value={editingTask.comments || ''}
                                    onChange={(e) => setEditingTask({ ...editingTask, comments: e.target.value })}
                                    className="w-full px-3 py-2 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                    placeholder="Ingrese notas o comentarios de la tarea..."
                                />
                            </div>

                            <div className="flex justify-end gap-3 pt-4 border-t border-border">
                                <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={() => setEditingTask(null)}
                                    disabled={isSaving}
                                >
                                    Cancelar
                                </Button>
                                <Button
                                    type="submit"
                                    variant="primary"
                                    disabled={isSaving}
                                >
                                    {isSaving ? 'Guardando...' : 'Guardar Cambios'}
                                </Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Modal: CONFIRMAR ELIMINACIÓN */}
            {deletingTask && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                    <div className="bg-card border border-destructive/30 rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150">
                        <div className="flex items-center gap-3 text-destructive">
                            <div className="p-2 rounded-full bg-destructive/10">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                            </div>
                            <h3 className="text-lg font-bold text-foreground">¿Eliminar Tarea de Implementación?</h3>
                        </div>

                        <p className="text-sm text-muted-foreground">
                            ¿Está seguro de que desea eliminar permanentemente esta tarea? Esta acción no se puede deshacer.
                        </p>

                        <div className="p-3 bg-muted/50 rounded-lg text-xs space-y-1 border border-border">
                            <p><strong className="text-foreground">ECN:</strong> <span className="font-mono text-primary font-bold">{deletingTask.ecnId}</span></p>
                            <p><strong className="text-foreground">Tarea:</strong> {deletingTask.taskName}</p>
                            <p><strong className="text-foreground">Departamento:</strong> {deletingTask.department}</p>
                            <p><strong className="text-foreground">Familia:</strong> {deletingTask.family}</p>
                            <p><strong className="text-foreground">Estatus:</strong> {deletingTask.status}</p>
                        </div>

                        <div className="flex justify-end gap-3 pt-3 border-t border-border">
                            <Button
                                variant="secondary"
                                onClick={() => setDeletingTask(null)}
                                disabled={isDeleting}
                            >
                                Cancelar
                            </Button>
                            <Button
                                variant="danger"
                                onClick={handleDeleteTask}
                                disabled={isDeleting}
                            >
                                {isDeleting ? 'Eliminando...' : 'Eliminar Tarea'}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
