


import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { ECN, Assembly, ECNStatus, BOMComponent, BOMECNInfo } from '../types';
import * as api from '../services/api';
import { Card, Modal, Button, Toast, StatusBadge } from './ui';

interface AssemblyManagementPageProps {
    onDataChange: () => void;
}

const ComponentEcnsModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    componentId: string;
    ecns: BOMECNInfo[];
}> = ({ isOpen, onClose, componentId, ecns }) => {
    if (!isOpen) return null;

    const formatDate = (dateInput: string | null | undefined): string => {
        if (!dateInput) return 'N/A';
        const dateStr = String(dateInput);
        if (dateStr.startsWith('0001') || dateStr.startsWith('1900') || dateStr === 'N/A') {
            return 'N/A';
        }
        return dateStr.substring(0, 10);
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={`ECNs para componente: ${componentId}`} size="xl">
            <div className="overflow-y-auto h-[60vh] border rounded-md">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50 sticky top-0">
                        <tr>
                            <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase tracking-wider">ECN ID</th>
                            <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase tracking-wider">Descripción</th>
                            <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase tracking-wider">Estatus</th>
                            <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase tracking-wider">Fecha Implementación</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {ecns.map(ecn => (
                            <tr key={ecn.id}>
                                <td className="px-4 py-2 font-medium text-brand-accent">{ecn.id}</td>
                                <td className="px-4 py-2 text-gray-600 truncate max-w-md">{ecn.description}</td>
                                <td className="px-4 py-2"><StatusBadge status={ecn.status} /></td>
                                <td className="px-4 py-2 text-gray-600">{formatDate(ecn.implementationDate)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
             <div className="mt-6 flex justify-end">
                <Button onClick={onClose}>Cerrar</Button>
            </div>
        </Modal>
    );
};


const AssemblyManagementPage: React.FC<AssemblyManagementPageProps> = ({ onDataChange }) => {
    const [assemblies, setAssemblies] = useState<Assembly[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('All');
    const [dateFilter, setDateFilter] = useState('all');
    const [selectedAssembly, setSelectedAssembly] = useState<Assembly | null>(null);
    const [bomSearchTerm, setBomSearchTerm] = useState('');
    const [bomStatusFilter, setBomStatusFilter] = useState('All');
    const [bomDateFilter, setBomDateFilter] = useState('all');
    const [editingComponent, setEditingComponent] = useState<{ id: string; description: string } | null>(null);
    const [newDescription, setNewDescription] = useState('');
    const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
    const [viewingComponentEcns, setViewingComponentEcns] = useState<{ componentId: string; ecns: BOMECNInfo[] } | null>(null);

    const fetchData = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const assemblyData = await api.getAssemblies();
            setAssemblies(assemblyData);
        } catch (err) {
            setError("No se pudieron cargar los datos de ensambles.");
            console.error(err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const filteredAssemblies = useMemo(() => {
        const lowercasedSearch = searchTerm.toLowerCase().trim();

        return assemblies.filter(assembly => {
            const searchTermMatch = !lowercasedSearch || (
                assembly.id.toLowerCase().includes(lowercasedSearch) ||
                assembly.description.toLowerCase().includes(lowercasedSearch) ||
                assembly.bom.some(c => c.componentId.toLowerCase().includes(lowercasedSearch))
            );
            if (!searchTermMatch) return false;

            const associatedEcns = assembly.bom.flatMap(component => component.ecns);
            if (associatedEcns.length === 0) {
                return statusFilter === 'All' && dateFilter === 'all';
            }

            const statusMatch = statusFilter === 'All' || associatedEcns.some(ecn => ecn.status === statusFilter);
            if (!statusMatch) return false;

            if (dateFilter !== 'all') {
                const now = new Date();
                let days;
                switch (dateFilter) {
                    case 'last30': days = 30; break;
                    case 'last90': days = 90; break;
                    case 'lastYear': days = 365; break;
                    default: days = 0;
                }
                
                const cutoffDate = new Date();
                cutoffDate.setDate(now.getDate() - days);

                const dateMatch = associatedEcns.some(ecn => {
                    if (ecn.status !== ECNStatus.Implemented || !ecn.implementationDate || ecn.implementationDate === 'N/A') {
                        return false;
                    }
                    const implDate = new Date(ecn.implementationDate);
                    return implDate >= cutoffDate && implDate <= now;
                });
                if (!dateMatch) return false;
            }
            
            return true;
        });
    }, [assemblies, searchTerm, statusFilter, dateFilter]);
    
    const filteredBom = useMemo(() => {
        if (!selectedAssembly) return [];
        
        let bom = selectedAssembly.bom;

        // Filter by text search first
        if (bomSearchTerm.trim()) {
            const lowercasedFilter = bomSearchTerm.toLowerCase();
            bom = bom.filter(comp => 
                comp.componentId.toLowerCase().includes(lowercasedFilter) || 
                comp.description.toLowerCase().includes(lowercasedFilter)
            );
        }

        // Then filter by status and date
        if (bomStatusFilter !== 'All' || bomDateFilter !== 'all') {
            bom = bom.filter(comp => {
                const componentEcns = comp.ecns;
                if (componentEcns.length === 0) return false;

                const statusMatch = bomStatusFilter === 'All' || componentEcns.some(ecn => ecn.status === bomStatusFilter);
                if (!statusMatch) return false;

                if (bomDateFilter !== 'all') {
                    const now = new Date();
                    const days = bomDateFilter === 'last30' ? 30 : bomDateFilter === 'last90' ? 90 : 365;
                    const cutoffDate = new Date();
                    cutoffDate.setDate(now.getDate() - days);

                    const dateMatch = componentEcns.some(ecn => {
                         if (ecn.status !== ECNStatus.Implemented || !ecn.implementationDate || ecn.implementationDate === 'N/A') return false;
                         const implDate = new Date(ecn.implementationDate);
                         return implDate >= cutoffDate && implDate <= now;
                    });
                    if (!dateMatch) return false;
                }
                
                return true;
            });
        }

        return bom.sort((a,b) => a.componentId.localeCompare(b.componentId));

    }, [selectedAssembly, bomSearchTerm, bomStatusFilter, bomDateFilter]);

    const handleEditClick = (component: BOMComponent) => {
        setEditingComponent({ id: component.componentId, description: component.description });
        setNewDescription(component.description);
    };

    const handleViewComponentEcns = (component: BOMComponent) => {
        setViewingComponentEcns({ componentId: component.componentId, ecns: component.ecns });
    };

    const onUpdateComponentDescription = useCallback(async (componentId: string, newDescription: string) => {
        await api.updateComponentDescription(componentId, newDescription);
        onDataChange();
        await fetchData(); // Re-fetch local data as well
    }, [onDataChange, fetchData]);

    const handleSaveDescription = async () => {
        if (!editingComponent) return;
        try {
            await onUpdateComponentDescription(editingComponent.id, newDescription);
            setNotification({ message: 'Descripción actualizada correctamente.', type: 'success'});
            setEditingComponent(null);
        } catch (error) {
            setNotification({ message: 'Error al guardar la descripción.', type: 'error'});
            console.error("Failed to save description", error);
        }
    };

    if (isLoading) {
        return <div className="text-center p-8">Cargando ensambles...</div>;
    }

    if (error) {
        return (
             <Card className="text-center py-8">
                <p className="text-red-500 mb-4">{error}</p>
                <Button onClick={fetchData}>Intentar de nuevo</Button>
            </Card>
        );
    }

    return (
        <div className="space-y-6">
            {notification && <Toast message={notification.message} type={notification.type} onClose={() => setNotification(null)} />}
            <h1 className="text-3xl font-bold text-gray-800">Gestión de Ensambles (BOM)</h1>
            <p className="text-gray-600">Explore los ensambles y los componentes que los conforman, construidos a partir de los datos de los ECNs.</p>

            <Card>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="md:col-span-1">
                        <h2 className="text-xl font-semibold text-gray-800 mb-4">Lista de Ensambles ({filteredAssemblies.length})</h2>
                        <div className="space-y-3 mb-4">
                            <input
                                type="text"
                                placeholder="Buscar ensamble o componente..."
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-red bg-gray-100 text-gray-900"
                            />
                            <div className="flex flex-col sm:flex-row gap-3">
                                <select
                                    value={statusFilter}
                                    onChange={e => setStatusFilter(e.target.value)}
                                    className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-red bg-gray-100 text-gray-900 text-sm"
                                >
                                    <option value="All">Todos los estados</option>
                                    <option value={ECNStatus.Pending}>Pendiente</option>
                                    <option value={ECNStatus.Implemented}>Implementado</option>
                                    <option value={ECNStatus.Canceled}>Cancelado</option>
                                </select>
                                <select
                                    value={dateFilter}
                                    onChange={e => setDateFilter(e.target.value)}
                                    className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-red bg-gray-100 text-gray-900 text-sm"
                                >
                                    <option value="all">Cualquier fecha</option>
                                    <option value="last30">Implementado últimos 30 días</option>
                                    <option value="last90">Implementado últimos 90 días</option>
                                    <option value="lastYear">Implementado último año</option>
                                </select>
                            </div>
                        </div>
                        <div className="overflow-y-auto h-[55vh] border rounded-md">
                            {filteredAssemblies.map(assembly => (
                                <div
                                    key={assembly.id}
                                    className={`p-3 cursor-pointer border-b hover:bg-gray-100 ${selectedAssembly?.id === assembly.id ? 'bg-brand-red bg-opacity-10' : ''}`}
                                    onClick={() => setSelectedAssembly(assembly)}
                                >
                                    <p className="font-semibold text-brand-primary">{assembly.id}</p>
                                    <p className="text-sm text-gray-500 truncate">{assembly.description || 'Sin descripción'}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="md:col-span-2">
                        {selectedAssembly ? (
                            <div>
                                <div className="space-y-4 mb-4">
                                    <div>
                                        <h2 className="text-2xl font-bold text-gray-800">{selectedAssembly.id}</h2>
                                        <p className="text-gray-600">{selectedAssembly.description || 'Sin descripción'}</p>
                                    </div>
                                    <div className="flex flex-col sm:flex-row gap-4">
                                        <input
                                            type="text"
                                            placeholder="Buscar en BOM..."
                                            value={bomSearchTerm}
                                            onChange={e => setBomSearchTerm(e.target.value)}
                                            className="w-full sm:w-1/2 px-3 py-1.5 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-red bg-gray-100 text-gray-900"
                                        />
                                         <select
                                            value={bomStatusFilter}
                                            onChange={e => setBomStatusFilter(e.target.value)}
                                            className="w-full sm:w-auto px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-red bg-gray-100 text-gray-900 text-sm"
                                        >
                                            <option value="All">Filtrar BOM por estado...</option>
                                            <option value={ECNStatus.Pending}>Pendiente</option>
                                            <option value={ECNStatus.Implemented}>Implementado</option>
                                            <option value={ECNStatus.Canceled}>Cancelado</option>
                                        </select>
                                        <select
                                            value={bomDateFilter}
                                            onChange={e => setBomDateFilter(e.target.value)}
                                            className="w-full sm:w-auto px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-red bg-gray-100 text-gray-900 text-sm"
                                        >
                                            <option value="all">Filtrar BOM por fecha...</option>
                                            <option value="last30">Imp. últimos 30d</option>
                                            <option value="last90">Imp. últimos 90d</option>
                                            <option value="lastYear">Imp. último año</option>
                                        </select>
                                    </div>
                                </div>

                                <h3 className="text-lg font-semibold text-gray-700 mb-2">Lista de Materiales (BOM) - {filteredBom.length} componentes</h3>
                                <div className="overflow-y-auto h-[60vh] border rounded-md">
                                     <table className="min-w-full divide-y divide-gray-200">
                                        <thead className="bg-gray-50 sticky top-0">
                                            <tr>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Componente</th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Descripción</th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ECNs</th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Acciones</th>
                                            </tr>
                                        </thead>
                                        <tbody className="bg-white divide-y divide-gray-200">
                                            {filteredBom.map(comp => (
                                                <tr key={comp.componentId}>
                                                    <td className="px-4 py-2 whitespace-nowrap text-sm font-medium text-gray-900">{comp.componentId}</td>
                                                    <td className="px-4 py-2 text-sm text-gray-500">{comp.description || '—'}</td>
                                                    <td className="px-4 py-2 text-sm text-gray-500">
                                                        <Button variant="secondary" onClick={() => handleViewComponentEcns(comp)}>
                                                            Ver ({comp.ecns.length})
                                                        </Button>
                                                    </td>
                                                     <td className="px-4 py-2 whitespace-nowrap text-sm">
                                                        <Button onClick={() => handleEditClick(comp)}>Editar</Button>
                                                    </td>
                                                </tr>
                                            ))}
                                             {filteredBom.length === 0 && (
                                                <tr>
                                                    <td colSpan={4} className="text-center py-4 text-gray-500">
                                                        No hay componentes que coincidan con los filtros.
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ) : (
                            <div className="flex items-center justify-center h-full bg-gray-50 rounded-md">
                                <p className="text-gray-500">Seleccione un ensamble de la lista para ver sus detalles.</p>
                            </div>
                        )}
                    </div>
                </div>
            </Card>

            <Modal
                isOpen={!!editingComponent}
                onClose={() => setEditingComponent(null)}
                title={`Editar Descripción para ${editingComponent?.id}`}
                size="lg"
            >
                <div>
                    <label htmlFor="component-description" className="block text-sm font-medium text-gray-700">
                        Nueva Descripción
                    </label>
                    <textarea
                        id="component-description"
                        rows={4}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-red focus:ring-1 focus:ring-brand-red sm:text-sm bg-gray-100 text-gray-900"
                        value={newDescription}
                        onChange={(e) => setNewDescription(e.target.value)}
                    />
                </div>
                <div className="mt-6 flex justify-end space-x-2">
                    <Button variant="secondary" onClick={() => setEditingComponent(null)}>Cancelar</Button>
                    <Button variant="primary" onClick={handleSaveDescription}>Guardar</Button>
                </div>
            </Modal>
            
            <ComponentEcnsModal
                isOpen={!!viewingComponentEcns}
                onClose={() => setViewingComponentEcns(null)}
                componentId={viewingComponentEcns?.componentId || ''}
                ecns={viewingComponentEcns?.ecns || []}
            />
        </div>
    );
};

export default AssemblyManagementPage;