import React, { useState, useEffect, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import * as api from '../services/api';
import { Card, Button, Toast } from './ui';

interface MatVesda {
    id?: number;
    material: string;
    price: number;
    abc_indicator: string;
    material_description: string;
    plant: string;
    last_change: string;
    base_unit_of_measure: string;
    purchasing_group: string;
    mrp_type: string;
    valuation_class: string;
    currency: string;
    price_unit: number;
    price_control: string;
    material_type: string;
    material_group: string;
    valuation_type: string;
    created_by: string;
}

interface AssemblySkuFamilyItem {
    assembly: string;
    sku: string;
    family: string;
}

const VesdaMaterialImporter: React.FC<{ onImport: () => void, setNotification: (n: { message: string, type: 'success' | 'error' } | null) => void }> = ({ onImport, setNotification }) => {
    const [isLoading, setIsLoading] = useState(false);

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setIsLoading(true);
        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data, { cellDates: true });
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const json = XLSX.utils.sheet_to_json(worksheet) as any[];

            if (json.length === 0) throw new Error("El archivo está vacío.");

            const dataToImport = json.map(row => {
                const newRow: any = {};
                for (const key in row) {
                    const normalizedKey = key.trim().toLowerCase();
                    if (normalizedKey === 'material') newRow.material = String(row[key]);
                    else if (normalizedKey === 'price') newRow.price = Number(row[key]);
                    else if (normalizedKey === 'abc indicator') newRow.abc_indicator = String(row[key]);
                    else if (normalizedKey === 'material description') newRow.material_description = String(row[key]);
                    else if (normalizedKey === 'plant') newRow.plant = String(row[key]);
                    else if (normalizedKey === 'last change') {
                        const date = row[key];
                        if (date instanceof Date) {
                            newRow.last_change = date.toISOString().split('T')[0];
                        } else {
                            newRow.last_change = String(row[key]);
                        }
                    }
                    else if (normalizedKey === 'base unit of measure') newRow.base_unit_of_measure = String(row[key]);
                    else if (normalizedKey === 'purchasing group') newRow.purchasing_group = String(row[key]);
                    else if (normalizedKey === 'mrp type') newRow.mrp_type = String(row[key]);
                    else if (normalizedKey === 'valuation class') newRow.valuation_class = String(row[key]);
                    else if (normalizedKey === 'currency') newRow.currency = String(row[key]);
                    else if (normalizedKey === 'price unit') newRow.price_unit = Number(row[key]);
                    else if (normalizedKey === 'price control') newRow.price_control = String(row[key]);
                    else if (normalizedKey === 'material type') newRow.material_type = String(row[key]);
                    else if (normalizedKey === 'material group') newRow.material_group = String(row[key]);
                    else if (normalizedKey === 'valuation type') newRow.valuation_type = String(row[key]);
                    else if (normalizedKey === 'created by') newRow.created_by = String(row[key]);
                }
                return newRow;
            }).filter(r => r.material);

            const result = await api.importMatVesda(dataToImport);
            setNotification({ 
                message: `Importación finalizada: ${result.inserted} nuevos, ${result.updated} actualizados, ${result.skipped} omitidos.`, 
                type: 'success' 
            });
            onImport();
        } catch (err) {
            setNotification({ message: (err as Error).message, type: 'error' });
        } finally {
            setIsLoading(false);
            event.target.value = '';
        }
    };

    const handleDownloadTemplate = () => {
        const data = [{ 
            'Material': '18893-XTR', 
            'Price': 36.88, 
            'ABC Indicator': 'C',
            'Material Description': 'SCREW M4X20 PAN HD POZI.ZN',
            'Plant': '5731',
            'Last Change': '3/24/2026',
            'Base Unit of Measure': 'EA',
            'Purchasing Group': '7F1',
            'MRP Type': 'PD',
            'Valuation Class': '1000',
            'Currency': 'EUR',
            'Price Unit': 1000,
            'Price control': 'S',
            'Material Type': 'ZINV',
            'Material Group': 'M6Y',
            'Valuation Type': '',
            'Created by': 'ZINFORMAT_AL'
        }];
        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'VESDA_Materials');
        XLSX.writeFile(workbook, 'plantilla_vesda_material.xlsx');
    };

    return (
        <Card>
            <h2 className="text-xl font-semibold text-foreground">Importar Materiales VESDA</h2>
            <p className="text-sm text-muted-foreground my-2">Cargue el archivo Excel con los materiales permitidos para sitios diferentes a 5201. El archivo debe contener las columnas exactas del reporte SAP de materiales.</p>
            <div className="flex items-center space-x-4 mt-4">
                <label htmlFor="vesda-import" className="cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 rounded-md text-sm font-medium transition-colors">
                    {isLoading ? 'Procesando...' : 'Seleccionar Archivo'}
                </label>
                <input id="vesda-import" type="file" className="hidden" accept=".xlsx, .xls" onChange={handleFileChange} disabled={isLoading} />
                <Button variant="secondary" onClick={handleDownloadTemplate}>Descargar Plantilla</Button>
            </div>
        </Card>
    );
};

const VesdaMaterialPage: React.FC = () => {
    const [activeTab, setActiveTab] = useState<'vesda' | 'skuFamily'>('vesda');
    const [materials, setMaterials] = useState<MatVesda[]>([]);
    const [assemblySkuFamilies, setAssemblySkuFamilies] = useState<AssemblySkuFamilyItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
    const [search, setSearch] = useState('');
    const [searchSkuTab, setSearchSkuTab] = useState('');

    // Editing state for SKU / Family
    const [editingAssembly, setEditingAssembly] = useState<string | null>(null);
    const [editSku, setEditSku] = useState('');
    const [editFamily, setEditFamily] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const fetchMaterials = useCallback(async () => {
        setIsLoading(true);
        try {
            const data = await api.getMatVesda();
            setMaterials(Array.isArray(data) ? data : []);
        } catch (error) {
            console.error("Failed to fetch VESDA materials", error);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const fetchAssemblySkuFamilies = useCallback(async () => {
        setIsLoading(true);
        try {
            const data = await api.getAssemblySkuFamily();
            setAssemblySkuFamilies(Array.isArray(data) ? data : []);
        } catch (error) {
            console.error("Failed to fetch assembly SKU family mapping", error);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchMaterials();
        fetchAssemblySkuFamilies();
    }, [fetchMaterials, fetchAssemblySkuFamilies]);

    const filteredMaterials = useMemo(() => {
        if (!search.trim()) return materials;
        const lower = search.toLowerCase();
        return materials.filter(m => 
            (m.material?.toLowerCase().includes(lower)) ||
            (m.material_description?.toLowerCase().includes(lower)) ||
            (m.plant?.toLowerCase().includes(lower))
        );
    }, [materials, search]);

    const filteredSkuFamilies = useMemo(() => {
        if (!searchSkuTab.trim()) return assemblySkuFamilies;
        const lower = searchSkuTab.toLowerCase();
        return assemblySkuFamilies.filter(item => 
            (item.assembly?.toLowerCase().includes(lower)) ||
            (item.sku?.toLowerCase().includes(lower)) ||
            (item.family?.toLowerCase().includes(lower))
        );
    }, [assemblySkuFamilies, searchSkuTab]);

    const handleStartEdit = (item: AssemblySkuFamilyItem) => {
        setEditingAssembly(item.assembly);
        setEditSku(item.sku || '');
        setEditFamily(item.family || '');
    };

    const handleCancelEdit = () => {
        setEditingAssembly(null);
        setEditSku('');
        setEditFamily('');
    };

    const handleSaveEdit = async (assembly: string) => {
        setIsSaving(true);
        try {
            await api.updateAssemblySkuFamily(assembly, editSku, editFamily);
            setNotification({ message: `SKU y Familia actualizados correctamente para el ensamble ${assembly}.`, type: 'success' });
            setEditingAssembly(null);
            fetchAssemblySkuFamilies();
        } catch (err: any) {
            setNotification({ message: err.message || 'Error al actualizar SKU y Familia.', type: 'error' });
        } finally {
            setIsSaving(false);
        }
    };

    const handleExportSkuFamilyExcel = () => {
        if (filteredSkuFamilies.length === 0) {
            setNotification({ message: 'No hay datos de SKU y Familia para exportar.', type: 'error' });
            return;
        }
        const dataToExport = filteredSkuFamilies.map(item => ({
            'ENSAMBLE': item.assembly,
            'SKU': item.sku || '',
            'FAMILIA': item.family || ''
        }));
        const worksheet = XLSX.utils.json_to_sheet(dataToExport);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'SKU_Ensamble_Familia');
        XLSX.writeFile(workbook, `SKU_Ensamble_Familia_${new Date().toISOString().split('T')[0]}.xlsx`);
        setNotification({ message: 'Archivo Excel de SKU, Ensamble y Familia exportado con éxito.', type: 'success' });
    };

    return (
        <div className="space-y-6">
            {notification && <Toast message={notification.message} type={notification.type} onClose={() => setNotification(null)} />}
            <div>
                <h1 className="text-3xl font-bold text-foreground">Gestión VESDA y Mapeo de SKU / Familia</h1>
                <p className="text-muted-foreground mt-1">Gestione materiales VESDA y visualice / edite la relación automática de SKU, Ensamble y Familia para cada ECN.</p>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-border space-x-4">
                <button
                    onClick={() => setActiveTab('vesda')}
                    className={`pb-3 px-4 text-sm font-semibold border-b-2 transition-colors cursor-pointer ${
                        activeTab === 'vesda'
                            ? 'border-primary text-primary'
                            : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                >
                    Materiales VESDA ({materials.length})
                </button>
                <button
                    onClick={() => setActiveTab('skuFamily')}
                    className={`pb-3 px-4 text-sm font-semibold border-b-2 transition-colors cursor-pointer ${
                        activeTab === 'skuFamily'
                            ? 'border-primary text-primary'
                            : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                >
                    SKU, Ensamble y Familia ({assemblySkuFamilies.length})
                </button>
            </div>

            {activeTab === 'vesda' ? (
                <>
                    <VesdaMaterialImporter onImport={fetchMaterials} setNotification={setNotification} />

                    <Card>
                        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 gap-4">
                            <h2 className="text-xl font-semibold text-foreground">Materiales Registrados ({filteredMaterials.length})</h2>
                            <input
                                type="text"
                                placeholder="Buscar por material o descripción..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className="w-full md:w-96 px-4 py-2 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary bg-muted text-foreground text-sm"
                            />
                        </div>
                        <div className="overflow-x-auto max-h-[500px] border border-border rounded-md shadow-sm">
                            <table className="min-w-full divide-y divide-border">
                                <thead className="bg-muted/70 sticky top-0">
                                    <tr>
                                        <th className="px-6 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Material</th>
                                        <th className="px-6 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Descripción</th>
                                        <th className="px-6 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Planta</th>
                                        <th className="px-6 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Precio</th>
                                        <th className="px-6 py-3.5 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider">Moneda</th>
                                        <th className="px-6 py-3.5 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider">Últ. Cambio</th>
                                    </tr>
                                </thead>
                                <tbody className="bg-card divide-y divide-border">
                                    {isLoading ? (
                                        <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">Cargando materiales...</td></tr>
                                    ) : filteredMaterials.length > 0 ? (
                                        filteredMaterials.map((m, idx) => (
                                            <tr key={m.id || idx} className="hover:bg-muted/50 transition-colors">
                                                <td className="px-6 py-3.5 whitespace-nowrap text-sm font-bold font-mono text-primary">{m.material}</td>
                                                <td className="px-6 py-3.5 text-sm text-muted-foreground max-w-xs truncate">{m.material_description}</td>
                                                <td className="px-6 py-3.5 whitespace-nowrap text-sm text-foreground font-mono">{m.plant}</td>
                                                <td className="px-6 py-3.5 whitespace-nowrap text-sm text-foreground text-right font-mono">{m.price}</td>
                                                <td className="px-6 py-3.5 whitespace-nowrap text-sm text-muted-foreground text-center">{m.currency}</td>
                                                <td className="px-6 py-3.5 whitespace-nowrap text-sm text-muted-foreground text-center">{m.last_change ? new Date(m.last_change).toLocaleDateString() : '—'}</td>
                                            </tr>
                                        ))
                                    ) : (
                                        <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">No hay materiales registrados.</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </Card>
                </>
            ) : (
                <Card>
                    <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
                        <div>
                            <h2 className="text-xl font-semibold text-foreground">Relación y Edición de SKU, Ensamble y Familia</h2>
                            <p className="text-sm text-muted-foreground mt-0.5">Modifique directamente los SKUs o Familias asociados a cada ensamble en los ECNs.</p>
                        </div>
                        <div className="flex items-center gap-3 w-full md:w-auto">
                            <input
                                type="text"
                                placeholder="Buscar ensamble, SKU o familia..."
                                value={searchSkuTab}
                                onChange={e => setSearchSkuTab(e.target.value)}
                                className="w-full md:w-80 px-4 py-2 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary bg-muted text-foreground text-sm"
                            />
                            <Button variant="secondary" onClick={handleExportSkuFamilyExcel}>
                                Exportar Excel
                            </Button>
                        </div>
                    </div>

                    <div className="overflow-x-auto max-h-[550px] border border-border rounded-md shadow-sm">
                        <table className="min-w-full divide-y divide-border">
                            <thead className="bg-muted/70 sticky top-0">
                                <tr>
                                    <th className="px-6 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Ensamble</th>
                                    <th className="px-6 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">SKU(s)</th>
                                    <th className="px-6 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Familia</th>
                                    <th className="px-6 py-3.5 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider w-36">Acciones</th>
                                </tr>
                            </thead>
                            <tbody className="bg-card divide-y divide-border">
                                {isLoading ? (
                                    <tr><td colSpan={4} className="text-center py-8 text-muted-foreground">Cargando mapeo de ensambles, SKUs y familias...</td></tr>
                                ) : filteredSkuFamilies.length > 0 ? (
                                    filteredSkuFamilies.map((item, idx) => {
                                        const isEditing = editingAssembly === item.assembly;
                                        return (
                                            <tr key={`${item.assembly}-${idx}`} className="hover:bg-muted/50 transition-colors">
                                                <td className="px-6 py-3.5 whitespace-nowrap text-sm font-bold font-mono text-primary">{item.assembly}</td>
                                                <td className="px-6 py-3.5 whitespace-nowrap text-sm font-semibold font-mono text-foreground">
                                                    {isEditing ? (
                                                        <input
                                                            type="text"
                                                            value={editSku}
                                                            onChange={e => setEditSku(e.target.value)}
                                                            className="w-full px-2.5 py-1 text-xs border border-input rounded bg-background text-foreground focus:ring-1 focus:ring-primary font-mono"
                                                            placeholder="SKU..."
                                                        />
                                                    ) : (
                                                        item.sku || '—'
                                                    )}
                                                </td>
                                                <td className="px-6 py-3.5 whitespace-nowrap text-sm text-muted-foreground font-medium">
                                                    {isEditing ? (
                                                        <input
                                                            type="text"
                                                            value={editFamily}
                                                            onChange={e => setEditFamily(e.target.value)}
                                                            className="w-full px-2.5 py-1 text-xs border border-input rounded bg-background text-foreground focus:ring-1 focus:ring-primary"
                                                            placeholder="Familia..."
                                                        />
                                                    ) : (
                                                        <span className="bg-secondary/20 text-secondary-foreground px-2 py-1 rounded text-xs">
                                                            {item.family || 'VESDA'}
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-6 py-3.5 whitespace-nowrap text-center">
                                                    {isEditing ? (
                                                        <div className="flex items-center justify-center gap-2">
                                                            <Button
                                                                onClick={() => handleSaveEdit(item.assembly)}
                                                                disabled={isSaving}
                                                            >
                                                                {isSaving ? 'Guardando...' : 'Guardar'}
                                                            </Button>
                                                            <Button
                                                                variant="secondary"
                                                                onClick={handleCancelEdit}
                                                                disabled={isSaving}
                                                            >
                                                                Cancelar
                                                            </Button>
                                                        </div>
                                                    ) : (
                                                        <Button
                                                            variant="secondary"
                                                            onClick={() => handleStartEdit(item)}
                                                        >
                                                            Editar
                                                        </Button>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })
                                ) : (
                                    <tr><td colSpan={4} className="text-center py-8 text-muted-foreground">No se encontraron mapeos de SKU, Ensamble y Familia registrados.</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </Card>
            )}
        </div>
    );
};

export default VesdaMaterialPage;
