import React, { useState } from 'react';
import { Card, Button } from './ui';

interface LoadDbPageProps {
  onDbLoad: (file?: File) => void;
  setIsLoading: (isLoading: boolean) => void;
  loadingError: string | null;
}

const LoadDbPage: React.FC<LoadDbPageProps> = ({ onDbLoad, setIsLoading, loadingError }) => {
    const [file, setFile] = useState<File | null>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0];
        if (selectedFile) {
            setFile(selectedFile);
        }
    };

    const handleLoad = () => {
        if (file) {
            setIsLoading(true);
            onDbLoad(file);
        }
    };
    
    const handleCreateNew = () => {
        setIsLoading(true);
        onDbLoad(); // No file means create new
    };

    return (
        <div className="flex items-center justify-center min-h-screen bg-brand-bg">
            <Card className="max-w-lg w-full">
                <h1 className="text-2xl font-bold text-gray-800 text-center">ECN Manager</h1>
                <p className="text-gray-600 text-center mt-2">Bienvenido. Para comenzar, cargue una base de datos existente o cree una nueva.</p>
                
                {loadingError && <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative my-4 text-sm" role="alert">{loadingError}</div>}
                
                <div className="mt-6 space-y-4">
                    <div className="p-4 border-2 border-dashed border-gray-300 rounded-lg text-center">
                        <label htmlFor="db-upload" className="cursor-pointer text-brand-red hover:underline font-medium">
                            {file ? `Archivo seleccionado: ${file.name}` : 'Seleccione un archivo de base de datos (.sqlite, .db)'}
                        </label>
                        <input id="db-upload" type="file" className="hidden" accept=".db,.sqlite,.sqlite3" onChange={handleFileChange} />
                        <p className="text-xs text-gray-500 mt-1">Este archivo se procesará localmente en su navegador.</p>
                    </div>
                    
                    <Button variant="primary" onClick={handleLoad} disabled={!file} className="w-full">
                        Cargar Base de Datos
                    </Button>
                </div>
                
                <div className="mt-4 text-center">
                    <p className="text-sm text-gray-500">O</p>
                    <Button variant="secondary" onClick={handleCreateNew} className="mt-2">
                        Crear Nueva Base de Datos Vacía
                    </Button>
                </div>
            </Card>
        </div>
    );
};

export default LoadDbPage;