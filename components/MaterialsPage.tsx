import React, { useState, useEffect, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import * as api from '../services/api';
import { MaterialItem } from '../types';
import { Card, Button, Toast } from './ui';

export const MaterialsPage: React.FC = () => {
    const [materials, setMaterials] = useState<MaterialItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

    // Default date range: today to 90 days ahead
    const today = new Date();
    const defaultStart = today.toISOString().split('T')[0];
    const defaultEnd = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [startDate, setStartDate] = useState(defaultStart);
    const [endDate, setEndDate] = useState(defaultEnd);

    // Column filters
    const [columnFilters, setColumnFilters] = useState({
        partNumber: '',
        ecnId: '',
        family: '',
        assembly: '',
        site: '',
        status: 'Todos'
    });

    // Expanded part numbers for accordion view
    const [expandedParts, setExpandedParts] = useState<Record<string, boolean>>({});

    const fetchMaterials = useCallback(async () => {
        setIsLoading(true);
        try {
            const data = await api.getMaterials();
            setMaterials(Array.isArray(data) ? data : []);
        } catch (error) {
            console.error("Failed to fetch materials", error);
            setNotification({ message: 'Error al cargar la lista de materiales.', type: 'error' });
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchMaterials();
    }, [fetchMaterials]);

    // Group materials by partNumber and sort by closest implementation date
    const groupedMaterials = useMemo(() => {
        const filtered = materials.filter(m => {
            // General search
            const query = search.toLowerCase().trim();
            if (query) {
                const matchGeneral = 
                    (m.partNumber && m.partNumber.toLowerCase().includes(query)) ||
                    (m.ecnId && m.ecnId.toLowerCase().includes(query)) ||
                    (m.assembly && m.assembly.toLowerCase().includes(query)) ||
                    (m.family && m.family.toLowerCase().includes(query)) ||
                    (m.oldComponent && m.oldComponent.toLowerCase().includes(query));
                if (!matchGeneral) return false;
            }

            // Column filters
            if (columnFilters.partNumber && !String(m.partNumber || '').toLowerCase().includes(columnFilters.partNumber.toLowerCase())) return false;
            if (columnFilters.ecnId && !String(m.ecnId || '').toLowerCase().includes(columnFilters.ecnId.toLowerCase())) return false;
            if (columnFilters.family && !String(m.family || '').toLowerCase().includes(columnFilters.family.toLowerCase())) return false;
            if (columnFilters.assembly && !String(m.assembly || '').toLowerCase().includes(columnFilters.assembly.toLowerCase())) return false;
            if (columnFilters.site && !String(m.site || '').toLowerCase().includes(columnFilters.site.toLowerCase())) return false;
            if (columnFilters.status && columnFilters.status !== 'Todos' && !String(m.ecnStatus || '').toLowerCase().includes(columnFilters.status.toLowerCase())) return false;

            // Date range filter
            if (startDate || endDate) {
                const itemDateStr = m.implementationDate ? m.implementationDate.split('T')[0] : '';
                if (!itemDateStr) return false;
                if (startDate && itemDateStr < startDate) return false;
                if (endDate && itemDateStr > endDate) return false;
            }

            return true;
        });

        // Group by partNumber
        const map = new Map<string, {
            partNumber: string;
            ecns: Set<string>;
            families: Set<string>;
            assemblies: Set<string>;
            sites: Set<string>;
            statuses: Set<string>;
            earliestDate: string;
            items: MaterialItem[];
        }>();

        filtered.forEach(m => {
            const pNum = m.partNumber || m.newComponent || m.oldComponent || 'N/A';
            if (!map.has(pNum)) {
                map.set(pNum, {
                    partNumber: pNum,
                    ecns: new Set(),
                    families: new Set(),
                    assemblies: new Set(),
                    sites: new Set(),
                    statuses: new Set(),
                    earliestDate: m.implementationDate || '',
                    items: []
                });
            }
            const group = map.get(pNum)!;
            if (m.ecnId) group.ecns.add(m.ecnId);
            if (m.family) group.families.add(m.family);
            if (m.assembly) group.assemblies.add(m.assembly);
            if (m.site) group.sites.add(m.site);
            if (m.ecnStatus) group.statuses.add(m.ecnStatus);
            group.items.push(m);

            if (m.implementationDate && (!group.earliestDate || m.implementationDate < group.earliestDate)) {
                group.earliestDate = m.implementationDate;
            }
        });

        return Array.from(map.values()).map(g => ({
            ...g,
            ecnsList: Array.from(g.ecns),
            familiesList: Array.from(g.families),
            assembliesList: Array.from(g.assemblies),
            sitesList: Array.from(g.sites),
            statusesList: Array.from(g.statuses)
        })).sort((a, b) => {
            const dateA = a.earliestDate ? new Date(a.earliestDate).getTime() : 0;
            const dateB = b.earliestDate ? new Date(b.earliestDate).getTime() : 0;
            return dateA - dateB; // Closest implementation date first
        });
    }, [materials, search, columnFilters, startDate, endDate]);

    const toggleExpand = (partNumber: string) => {
        setExpandedParts(prev => ({ ...prev, [partNumber]: !prev[partNumber] }));
    };

    const handleResetFilters = () => {
        setSearch('');
        setStartDate(defaultStart);
        setEndDate(defaultEnd);
        setColumnFilters({
            partNumber: '',
            ecnId: '',
            family: '',
            assembly: '',
            site: '',
            status: 'Todos'
        });
    };

    const handleExportExcel = () => {
        if (groupedMaterials.length === 0) {
            setNotification({ message: 'No hay datos para exportar.', type: 'error' });
            return;
        }
        const dataToExport: any[] = [];
        groupedMaterials.forEach(g => {
            g.items.forEach(m => {
                dataToExport.push({
                    'NUMERO DE PARTE': g.partNumber,
                    'ECN': m.ecnId,
                    'FECHA IMPLEMENTACION': m.implementationDate ? m.implementationDate.split('T')[0] : '',
                    'ENSAMBLE': m.assembly,
                    'SITIO / PLANTA': m.site,
                    'FAMILIA': m.family || '',
                    'ESTATUS ECN': m.ecnStatus,
                    'DESCRIPCION ECN': m.ecnDescription
                });
            });
        });

        const worksheet = XLSX.utils.json_to_sheet(dataToExport);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Materiales_Agrupados');
        XLSX.writeFile(workbook, `Materiales_ECN_${new Date().toISOString().split('T')[0]}.xlsx`);
        setNotification({ message: 'Archivo Excel exportado con éxito.', type: 'success' });
    };

    const formatDate = (dateStr: string) => {
        if (!dateStr) return '—';
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr.split('T')[0];
            return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
        } catch {
            return dateStr.split('T')[0];
        }
    };

    return (
        <div className="space-y-6">
            {notification && <Toast message={notification.message} type={notification.type} onClose={() => setNotification(null)} />}

            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">Módulo de Materiales y Componentes afectados por ECN</h1>
                    <p className="text-sm text-muted-foreground mt-1">
                        Materiales agrupados por número de parte con expansión para ver los ensambles y ECNs afectados. Ordenado por fecha más próxima.
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <Button variant="secondary" onClick={handleExportExcel}>
                        Exportar a Excel
                    </Button>
                    <Button onClick={fetchMaterials}>
                        Actualizar
                    </Button>
                </div>
            </div>

            <Card>
                {/* Date range & general search toolbar */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6 p-4 bg-muted/40 border border-border rounded-lg">
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Fecha Desde (Implementación)</label>
                        <input
                            type="date"
                            value={startDate}
                            onChange={(e) => setStartDate(e.target.value)}
                            className="w-full px-3 py-1.5 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Fecha Hasta (Implementación)</label>
                        <input
                            type="date"
                            value={endDate}
                            onChange={(e) => setEndDate(e.target.value)}
                            className="w-full px-3 py-1.5 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Búsqueda General</label>
                        <input
                            type="text"
                            placeholder="Buscar parte, ECN..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full px-3 py-1.5 border border-input rounded-md text-sm bg-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                    </div>
                    <div className="flex items-end gap-2">
                        <Button variant="secondary" onClick={handleResetFilters} className="w-full">
                            Limpiar Filtros
                        </Button>
                    </div>
                </div>

                <div className="flex justify-between items-center mb-4 px-1">
                    <div className="text-xs text-muted-foreground font-mono">
                        Materiales únicos: <span className="font-bold text-foreground">{groupedMaterials.length}</span> (Total ocurrencias: {materials.length})
                    </div>
                </div>

                <div className="overflow-x-auto border rounded-lg">
                    <table className="min-w-full divide-y divide-border">
                        <thead className="bg-muted/50">
                            <tr>
                                <th scope="col" className="w-12 px-2 py-3 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">#</th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                    <div>Número de Parte / Componente</div>
                                    <input
                                        type="text"
                                        placeholder="Filtrar parte..."
                                        value={columnFilters.partNumber}
                                        onChange={(e) => setColumnFilters(prev => ({ ...prev, partNumber: e.target.value }))}
                                        className="mt-1 w-full px-2 py-1 text-xs border border-input rounded bg-background text-foreground"
                                    />
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                    <div>ECN(s) Asociados</div>
                                    <input
                                        type="text"
                                        placeholder="Filtrar ECN..."
                                        value={columnFilters.ecnId}
                                        onChange={(e) => setColumnFilters(prev => ({ ...prev, ecnId: e.target.value }))}
                                        className="mt-1 w-full px-2 py-1 text-xs border border-input rounded bg-background text-foreground"
                                    />
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                    <div>Familia</div>
                                    <input
                                        type="text"
                                        placeholder="Filtrar familia..."
                                        value={columnFilters.family}
                                        onChange={(e) => setColumnFilters(prev => ({ ...prev, family: e.target.value }))}
                                        className="mt-1 w-full px-2 py-1 text-xs border border-input rounded bg-background text-foreground"
                                    />
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                    Fecha Implementación (Más Próxima)
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                    <div>Ensambles Afectados</div>
                                    <input
                                        type="text"
                                        placeholder="Filtrar ensamble..."
                                        value={columnFilters.assembly}
                                        onChange={(e) => setColumnFilters(prev => ({ ...prev, assembly: e.target.value }))}
                                        className="mt-1 w-full px-2 py-1 text-xs border border-input rounded bg-background text-foreground"
                                    />
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                    <div>Planta / Sitio</div>
                                    <input
                                        type="text"
                                        placeholder="Filtrar planta..."
                                        value={columnFilters.site}
                                        onChange={(e) => setColumnFilters(prev => ({ ...prev, site: e.target.value }))}
                                        className="mt-1 w-full px-2 py-1 text-xs border border-input rounded bg-background text-foreground"
                                    />
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                    <div>Estatus</div>
                                    <select
                                        value={columnFilters.status}
                                        onChange={(e) => setColumnFilters(prev => ({ ...prev, status: e.target.value }))}
                                        className="mt-1 w-full px-2 py-1 text-xs border border-input rounded bg-background text-foreground"
                                    >
                                        <option value="Todos">Todos</option>
                                        <option value="Pendiente">Pendiente</option>
                                        <option value="Implementado">Implementado</option>
                                    </select>
                                </th>
                            </tr>
                        </thead>
                        <tbody className="bg-card divide-y divide-border">
                            {isLoading ? (
                                <tr>
                                    <td colSpan={8} className="text-center py-8 text-muted-foreground">Cargando materiales y componentes...</td>
                                </tr>
                            ) : groupedMaterials.length > 0 ? (
                                groupedMaterials.map((g, idx) => {
                                    const isExpanded = !!expandedParts[g.partNumber];
                                    return (
                                        <React.Fragment key={`${g.partNumber}-${idx}`}>
                                            <tr className="hover:bg-muted/50 transition-colors font-medium">
                                                <td className="px-2 py-3 text-center">
                                                    <button
                                                        onClick={() => toggleExpand(g.partNumber)}
                                                        className="w-6 h-6 rounded bg-primary/10 hover:bg-primary/20 text-primary font-bold flex items-center justify-center text-xs transition-colors cursor-pointer"
                                                        title={isExpanded ? "Contraer detalles" : "Expandir para ver ensambles afectados"}
                                                    >
                                                        {isExpanded ? '−' : '+'}
                                                    </button>
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-sm font-bold font-mono text-primary flex items-center gap-2">
                                                    <span>{g.partNumber}</span>
                                                    <span className="text-[10px] bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded-full font-sans">
                                                        {g.assembliesList.length} {g.assembliesList.length === 1 ? 'ensamble' : 'ensambles'}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3 text-sm font-semibold font-mono text-foreground">
                                                    <div className="flex flex-wrap gap-1">
                                                        {g.ecnsList.map(ecn => (
                                                            <span key={ecn} className="bg-primary/10 text-primary px-1.5 py-0.5 rounded text-xs">
                                                                {ecn}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 text-sm text-foreground">
                                                    <div className="flex flex-wrap gap-1">
                                                        {g.familiesList.length > 0 ? g.familiesList.map(fam => (
                                                            <span key={fam} className="bg-secondary text-secondary-foreground px-2 py-0.5 rounded text-xs font-semibold">
                                                                {fam}
                                                            </span>
                                                        )) : '—'}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-sm font-semibold text-foreground">
                                                    {formatDate(g.earliestDate)}
                                                </td>
                                                <td className="px-4 py-3 text-sm text-muted-foreground">
                                                    <span className="truncate block max-w-xs" title={g.assembliesList.join(', ')}>
                                                        {g.assembliesList.join(', ') || '—'}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-sm text-muted-foreground font-mono">
                                                    {g.sitesList.join(', ') || '5205'}
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-sm">
                                                    <div className="flex flex-wrap gap-1">
                                                        {g.statusesList.map(st => (
                                                            <span key={st} className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                                                st === 'Implementado' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' :
                                                                'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                                                            }`}>
                                                                {st || 'Pendiente'}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </td>
                                            </tr>

                                            {/* Expanded Sub-table showing each assembly & ECN impact */}
                                            {isExpanded && (
                                                <tr>
                                                    <td colSpan={8} className="bg-muted/30 p-4 border-t border-b border-border">
                                                        <div className="text-xs font-bold text-foreground mb-2 uppercase tracking-wider flex items-center gap-2">
                                                            <span>Detalle de afectaciones para el componente:</span>
                                                            <span className="font-mono text-primary">{g.partNumber}</span>
                                                        </div>
                                                        <div className="overflow-x-auto bg-card rounded-lg border">
                                                            <table className="min-w-full divide-y divide-border text-xs">
                                                                <thead className="bg-muted/50">
                                                                    <tr>
                                                                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Ensamble Afectado</th>
                                                                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Número de ECN</th>
                                                                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Fecha Implementación</th>
                                                                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Demanda</th>
                                                                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Planta</th>
                                                                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Estatus</th>
                                                                    </tr>
                                                                </thead>
                                                                <tbody className="divide-y divide-border">
                                                                    {g.items.map((subItem, sIdx) => (
                                                                        <tr key={`${subItem.changeId}-${sIdx}`} className="hover:bg-muted/40">
                                                                            <td className="px-3 py-2 font-mono font-bold text-foreground">{subItem.assembly || '—'}</td>
                                                                            <td className="px-3 py-2 font-mono text-primary font-semibold">{subItem.ecnId}</td>
                                                                            <td className="px-3 py-2">{formatDate(subItem.implementationDate)}</td>
                                                                            <td className="px-3 py-2 font-mono">{subItem.demand || 0}</td>
                                                                            <td className="px-3 py-2 font-mono">{subItem.site || '5205'}</td>
                                                                            <td className="px-3 py-2">
                                                                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                                                                    subItem.ecnStatus === 'Implementado' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' :
                                                                                    'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                                                                                }`}>
                                                                                    {subItem.ecnStatus || 'Pendiente'}
                                                                                </span>
                                                                            </td>
                                                                        </tr>
                                                                    ))}
                                                                </tbody>
                                                            </table>
                                                        </div>
                                                    </td>
                                                </tr>
                                            )}
                                        </React.Fragment>
                                    );
                                })
                            ) : (
                                <tr>
                                    <td colSpan={7} className="text-center py-8 text-muted-foreground">
                                        No se encontraron materiales que coincidan con los filtros seleccionados.
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
