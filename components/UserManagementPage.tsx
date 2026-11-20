import React, { useState, useMemo } from 'react';
import { User } from '../types';
import { Card, Button, Toast, UserProfile, Modal } from './ui';
import * as XLSX from 'xlsx';

// A generic importer component can be extracted from Changes.tsx if needed, but for now I'll create a tailored one here.
interface UserImporterProps {
    onImport: (data: User[], fileName: string) => Promise<void>;
    setNotification: (notification: { message: string, type: 'success' | 'error' }) => void;
}

const UserImporter: React.FC<UserImporterProps> = ({ onImport, setNotification }) => {
    const [isLoading, setIsLoading] = useState(false);
    
    const requiredHeaders = ['id', 'name', 'email', 'department'];

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setIsLoading(true);
        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data, { type: 'array' });
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const json = XLSX.utils.sheet_to_json(worksheet) as any[];

             if (json.length === 0) {
                throw new Error("El archivo está vacío o no tiene el formato correcto.");
            }

            const normalizedJson = json.map(row => {
                const newRow: Record<string, any> = {};
                for (const key in row) {
                    if (Object.prototype.hasOwnProperty.call(row, key)) {
                        // Normalize keys: trim and lowercase
                        const normalizedKey = key.trim().toLowerCase();
                        if (normalizedKey === 'nombre') newRow['name'] = row[key];
                        else if (normalizedKey === 'correo') newRow['email'] = row[key];
                        else if (normalizedKey === 'departamento') newRow['department'] = row[key];
                        else if (normalizedKey === 'foto' || normalizedKey === 'photo') newRow['photo'] = row[key];
                        else newRow[normalizedKey] = row[key];
                    }
                }
                return newRow;
            });


            const headers = Object.keys(normalizedJson[0]).map(h => h.toLowerCase());
            const missingHeaders = requiredHeaders.filter(h => !headers.includes(h));

            if (missingHeaders.length > 0) {
                 throw new Error(`Faltan las siguientes columnas requeridas: ${missingHeaders.join(', ')}. Las columnas esperadas son: id, name, email, department (o en español: id, nombre, correo, departamento) y opcionalmente 'photo'.`);
            }
            
            // The validation for base64 photo is removed as per the request.
            // The system will now accept any string in the 'photo' column.
            const usersToImport = normalizedJson.map(user => {
                if (user.photo && typeof user.photo !== 'string') {
                    // Ensure it's a string, just in case Excel parses it as a number or something else
                    user.photo = String(user.photo);
                }
                return user;
            });

            await onImport(usersToImport as User[], file.name);
            
            setNotification({ message: 'Usuarios importados correctamente.', type: 'success' });

        } catch (err) {
            setNotification({ message: (err as Error).message || "Error al procesar el archivo.", type: 'error' });
        } finally {
            setIsLoading(false);
            event.target.value = ''; // Reset file input
        }
    };

    const handleDownloadTemplate = () => {
        const data = [{ 
            id: 'E123456', 
            name: 'John Doe', 
            email: 'john.doe@example.com', 
            department: 'Engineering',
            foto: '/9j/4AAQSkZJRg... (pegar string base64 de la imagen JPG aquí)'
        }];
        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Usuarios');
        worksheet['!cols'] = [{ wch: 15 }, { wch: 25 }, { wch: 30 }, { wch: 20 }, { wch: 50 }];
        XLSX.writeFile(workbook, 'plantilla_usuarios.xlsx');
    };

    return (
        <Card>
            <h2 className="text-xl font-semibold text-gray-800">Importar Usuarios</h2>
            <p className="text-sm text-gray-600 my-2">Importe usuarios desde un archivo Excel (.xlsx). El archivo debe contener las columnas 'id', 'name', 'email', 'department' y opcionalmente 'foto' (para imagen en base64).</p>
            <div className="flex items-center space-x-4 mt-4">
                 <label htmlFor="user-import" className="cursor-pointer bg-gray-200 text-gray-800 hover:bg-gray-300 px-4 py-2 rounded-md text-sm font-medium">
                    {isLoading ? 'Procesando...' : 'Seleccionar archivo'}
                </label>
                <input id="user-import" type="file" className="hidden" accept=".xlsx, .xls" onChange={handleFileChange} disabled={isLoading} />
                <Button variant="secondary" onClick={handleDownloadTemplate}>Descargar Plantilla</Button>
            </div>
        </Card>
    );
};


interface UserManagementPageProps {
    users: User[];
    onUserImport: (data: User[], fileName: string) => Promise<void>;
    onUpdateUser: (user: User) => Promise<void>;
}

const UserManagementPage: React.FC<UserManagementPageProps> = ({ users, onUserImport, onUpdateUser }) => {
    const [search, setSearch] = useState('');
    const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
    const [editingUser, setEditingUser] = useState<User | null>(null);
    const [formData, setFormData] = useState<User | null>(null);

    const filteredUsers = useMemo(() => {
        if (!search.trim()) return users;
        const lowercasedSearch = search.toLowerCase();
        return users.filter(user =>
            user.id.toLowerCase().includes(lowercasedSearch) ||
            user.name.toLowerCase().includes(lowercasedSearch) ||
            user.email.toLowerCase().includes(lowercasedSearch) ||
            user.department.toLowerCase().includes(lowercasedSearch)
        );
    }, [users, search]);
    
    const handleEditClick = (user: User) => {
        setEditingUser(user);
        // Deep copy to prevent mutating state directly while editing
        setFormData(JSON.parse(JSON.stringify(user)));
    };

    const handleFormChange = (field: keyof User, value: string) => {
        if (formData) {
            setFormData({ ...formData, [field]: value });
        }
    };

    const handleSave = async () => {
        if (!formData) return;
        try {
            await onUpdateUser(formData);
            setNotification({ message: 'Usuario actualizado correctamente.', type: 'success' });
            setEditingUser(null);
            setFormData(null);
        } catch (error) {
            setNotification({ message: 'Error al actualizar el usuario.', type: 'error' });
            console.error(error);
        }
    };

    const inputClass = "mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-red focus:ring-1 focus:ring-brand-red sm:text-sm bg-gray-100 text-gray-900";
    const labelClass = "block text-sm font-medium text-gray-700";

    return (
        <div className="space-y-6">
            {notification && <Toast message={notification.message} type={notification.type} onClose={() => setNotification(null)} />}
            <h1 className="text-3xl font-bold text-gray-800">Gestión de Usuarios</h1>
            
            <UserImporter onImport={onUserImport} setNotification={setNotification} />

            <Card>
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-semibold text-gray-800">Usuarios Existentes ({filteredUsers.length})</h2>
                    <input
                        type="text"
                        placeholder="Buscar por ID, nombre, correo..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="w-96 px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-red bg-gray-100 text-gray-900"
                    />
                </div>
                 <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                {['ID', 'Nombre', 'Correo', 'Departamento', 'Acciones'].map(header => (
                                     <th key={header} scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{header}</th>
                                ))}
                            </tr>
                        </thead>
                         <tbody className="bg-white divide-y divide-gray-200">
                            {filteredUsers.map(user => (
                                <tr key={user.id}>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{user.id}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                        <UserProfile user={user} />
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{user.email}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{user.department}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                                        <Button onClick={() => handleEditClick(user)}>Editar</Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                 </div>
            </Card>
            
            {editingUser && formData && (
                <Modal
                    isOpen={!!editingUser}
                    onClose={() => setEditingUser(null)}
                    title={`Editar Usuario: ${editingUser.name}`}
                    size="lg"
                >
                    <div className="space-y-4">
                        <div>
                            <label htmlFor="edit-name" className={labelClass}>Nombre</label>
                            <input id="edit-name" type="text" value={formData.name} onChange={(e) => handleFormChange('name', e.target.value)} className={inputClass} />
                        </div>
                        <div>
                            <label htmlFor="edit-email" className={labelClass}>Correo</label>
                            <input id="edit-email" type="email" value={formData.email} onChange={(e) => handleFormChange('email', e.target.value)} className={inputClass} />
                        </div>
                        <div>
                            <label htmlFor="edit-department" className={labelClass}>Departamento</label>
                            <input id="edit-department" type="text" value={formData.department} onChange={(e) => handleFormChange('department', e.target.value)} className={inputClass} />
                        </div>
                        <div>
                            <label htmlFor="edit-photo" className={labelClass}>Foto (Base64)</label>
                            <textarea id="edit-photo" rows={4} value={formData.photo || ''} onChange={(e) => handleFormChange('photo', e.target.value)} className={inputClass} placeholder="Pegue la cadena de texto base64 de la imagen aquí..."/>
                        </div>
                    </div>
                    <div className="mt-6 flex justify-end space-x-2">
                        <Button variant="secondary" onClick={() => setEditingUser(null)}>Cancelar</Button>
                        <Button variant="primary" onClick={handleSave}>Guardar Cambios</Button>
                    </div>
                </Modal>
            )}
        </div>
    );
};

export default UserManagementPage;