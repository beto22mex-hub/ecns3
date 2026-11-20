
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { HashRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { User } from './types';
import * as api from './services/api';
import { AuthProvider, useAuth } from './services/authContext';
import Dashboard from './components/Dashboard';
import Changes from './components/Changes';
import ChecklistPage from './components/ChecklistPage';
import EditEcnPage from './components/EditEcnPage';
import UserManagementPage from './components/UserManagementPage';
import VesdaMaterialPage from './components/VesdaMaterialPage';
import AssemblyManagementPage from './components/AssemblyManagementPage';
import { MaterialsPage } from './components/MaterialsPage';
import ReportsPage from './components/ReportsPage';
import SettingsPage from './components/SettingsPage';
import { ImplementationTasksPage } from './components/ImplementationTasksPage';
import { LoginPage } from './components/LoginPage';
import { AccessDeniedPage } from './components/AccessDeniedPage';
import { Card, Button } from './components/ui';
import { useTheme } from './components/ThemeContext';

// --- Helper Functions and Components ---
const SunIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></svg>
);

const MoonIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg>
);

const ThemeSwitcher: React.FC = () => {
    const { theme, toggleTheme } = useTheme();
    return (
        <Button
            variant="secondary"
            onClick={toggleTheme}
            className="!p-2 h-9 w-9 flex items-center justify-center bg-slate-700/50 hover:bg-slate-600/50 text-slate-300 hover:text-white"
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        >
            {theme === 'light' ? <SunIcon /> : <MoonIcon />}
        </Button>
    );
};

const AzureAuthHeaderWidget: React.FC<{ onOpenCorporateModal?: () => void }> = () => {
    const { currentUser, isSuperAdmin, isAuthEnabled, logout, loginWithAzure } = useAuth();
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [isLoggingIn, setIsLoggingIn] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    if (!currentUser) {
        return (
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={async () => {
                        setIsLoggingIn(true);
                        try {
                            await loginWithAzure();
                        } finally {
                            setIsLoggingIn(false);
                        }
                    }}
                    disabled={isLoggingIn}
                    className="bg-white hover:bg-slate-100 text-slate-900 flex items-center gap-2 py-1.5 px-3 text-xs font-bold shadow-sm rounded-lg transition-all border border-slate-200"
                >
                    <div className="w-3.5 h-3.5 grid grid-cols-2 gap-0.5 shrink-0">
                        <div className="bg-[#f25022]"></div>
                        <div className="bg-[#7fba00]"></div>
                        <div className="bg-[#00a4ef]"></div>
                        <div className="bg-[#ffb900]"></div>
                    </div>
                    <span>{isLoggingIn ? 'Iniciando...' : 'Iniciar con Microsoft SSO Interactivo'}</span>
                </button>
            </div>
        );
    }

    return (
        <div className="relative" ref={menuRef}>
            <button
                onClick={() => setIsMenuOpen(prev => !prev)}
                className={`flex items-center gap-2.5 p-1 pl-2 pr-2.5 rounded-lg border text-left transition-colors focus:outline-none focus:ring-1 focus:ring-sky-500 ${
                    isSuperAdmin
                        ? 'bg-slate-800/90 hover:bg-slate-700/90 border-emerald-500/50'
                        : 'bg-slate-800/80 hover:bg-slate-700/80 border-slate-700'
                }`}
            >
                <div className={`w-7 h-7 rounded-full text-white font-bold flex items-center justify-center text-xs shadow-inner shrink-0 overflow-hidden ${
                    isSuperAdmin ? 'bg-gradient-to-tr from-emerald-600 to-teal-500' : 'bg-gradient-to-tr from-sky-600 to-blue-500'
                }`}>
                    {currentUser.photo ? (
                        <img src={currentUser.photo} alt={currentUser.name} className="w-full h-full object-cover" />
                    ) : (
                        currentUser.name.charAt(0).toUpperCase()
                    )}
                </div>
                <div className="hidden lg:block text-left">
                    <div className="text-xs font-semibold text-slate-100 leading-tight max-w-[130px] truncate flex items-center gap-1.5">
                        {currentUser.name}
                        {isSuperAdmin && (
                            <span className="text-[10px] text-emerald-400" title="Super Admin H583623">★</span>
                        )}
                    </div>
                    <div className="text-[10px] font-mono leading-tight flex items-center gap-1">
                        <span className={`w-1.5 h-1.5 rounded-full ${isSuperAdmin ? 'bg-emerald-400' : 'bg-sky-400'}`}></span>
                        <span className={isSuperAdmin ? 'text-emerald-400 font-bold' : 'text-sky-300'}>
                            HID: {currentUser.hid || currentUser.id}
                        </span>
                        {!isAuthEnabled && (
                            <span className="text-[9px] text-amber-300 bg-amber-950/60 border border-amber-500/30 px-1 rounded ml-1 font-sans">
                                Directo
                            </span>
                        )}
                    </div>
                </div>
                <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform ${isMenuOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {isMenuOpen && (
                <div className="absolute right-0 mt-2 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
                    <div className="p-4 border-b border-slate-800 bg-slate-950/60">
                        <div className="flex items-center gap-3">
                            <div className={`w-10 h-10 rounded-full text-white font-bold flex items-center justify-center text-sm shadow-inner shrink-0 overflow-hidden ${
                                isSuperAdmin ? 'bg-gradient-to-tr from-emerald-600 to-teal-500' : 'bg-gradient-to-tr from-sky-600 to-blue-500'
                            }`}>
                                {currentUser.photo ? (
                                    <img src={currentUser.photo} alt={currentUser.name} className="w-full h-full object-cover" />
                                ) : (
                                    currentUser.name.charAt(0).toUpperCase()
                                )}
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-bold text-white truncate">{currentUser.name}</div>
                                <div className="text-xs text-slate-400 truncate">{currentUser.email || 'usuario@honeywell.com'}</div>
                            </div>
                        </div>

                        {/* HID & Role Banner */}
                        <div className="mt-3 p-2 rounded-lg bg-slate-900 border border-slate-800 space-y-1">
                            <div className="flex items-center justify-between text-[11px]">
                                <span className="text-slate-400">Honeywell ID:</span>
                                <span className="font-mono font-bold text-white">{currentUser.hid || currentUser.id}</span>
                            </div>
                            <div className="flex items-center justify-between text-[11px]">
                                <span className="text-slate-400">Nivel de Acceso:</span>
                                <span className={`font-semibold text-[10px] px-1.5 py-0.5 rounded ${
                                    isSuperAdmin
                                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-mono'
                                        : 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                                }`}>
                                    {isSuperAdmin ? 'Full Access (H583623)' : 'Solo Pantalla Home'}
                                </span>
                            </div>
                            <div className="flex items-center justify-between text-[11px] pt-1 border-t border-slate-800">
                                <span className="text-slate-400">Azure AD Auth:</span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                                    isAuthEnabled 
                                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40' 
                                        : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                }`}>
                                    {isAuthEnabled ? 'Activo (Login)' : 'Inactivo (Directo)'}
                                </span>
                            </div>
                        </div>

                        <div className="mt-2 flex items-center justify-between text-[11px] bg-slate-800/80 px-2.5 py-1 rounded-md border border-slate-700/60">
                            <span className="text-slate-400">Departamento:</span>
                            <span className="text-sky-300 font-medium">{currentUser.department || 'Engineering'}</span>
                        </div>
                    </div>

                    <div className="p-2 space-y-1 bg-slate-900">
                        <button
                            onClick={async () => {
                                setIsMenuOpen(false);
                                await loginWithAzure();
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-sky-400 hover:text-sky-300 hover:bg-sky-950/40 rounded-lg transition-colors text-left"
                        >
                            <svg className="w-4 h-4 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                            </svg>
                            Cambiar de Cuenta (Microsoft SSO)
                        </button>
                        {isSuperAdmin && (
                            <NavLink
                                to="/settings"
                                onClick={() => setIsMenuOpen(false)}
                                className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                            >
                                <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                </svg>
                                Configuración de Azure AD
                            </NavLink>
                        )}
                        <button
                            onClick={() => {
                                setIsMenuOpen(false);
                                logout();
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-950/30 rounded-lg transition-colors text-left"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                            </svg>
                            Cerrar Sesión
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

const Header: React.FC = () => {
    const { isSuperAdmin } = useAuth();
    const activeLinkClass = "bg-slate-700 text-white font-semibold";
    const inactiveLinkClass = "text-slate-300 hover:bg-slate-700/80 hover:text-white";
    const restrictedLinkClass = "text-slate-400 hover:bg-slate-800/60 flex items-center gap-1.5";
    const linkBaseClass = "px-3 py-2 rounded-md text-sm font-medium transition-colors";

    return (
        <header className="bg-[#222b3c] shadow-md border-b border-slate-700 sticky top-0 z-40">
            <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="flex items-center justify-between h-16">
                    <div className="flex items-center">
                        <NavLink to="/" className="flex items-center gap-3">
                            <span className="font-bold text-2xl text-red-600">Honeywell</span>
                            <span className="border-l border-slate-600 h-6"></span>
                            <span className="text-slate-400 hidden sm:inline text-xs">Digital Workplace</span>
                            <span className="text-slate-200 font-semibold text-sm sm:text-base">ECN Manager</span>
                        </NavLink>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="hidden md:flex items-baseline space-x-1 lg:space-x-3 mr-2">
                            <NavLink to="/" className={({ isActive }) => `${linkBaseClass} ${isActive ? activeLinkClass : inactiveLinkClass}`}>
                                Home
                            </NavLink>
                            <NavLink 
                                to="/changes" 
                                className={({ isActive }) => `${linkBaseClass} ${isActive ? activeLinkClass : isSuperAdmin ? inactiveLinkClass : restrictedLinkClass}`}
                                title={!isSuperAdmin ? 'Acceso reservado para Administrador H583623' : undefined}
                            >
                                Cambios {!isSuperAdmin && <span className="text-[10px] text-amber-400/80">🔒</span>}
                            </NavLink>
                            <NavLink 
                                to="/assemblies" 
                                className={({ isActive }) => `${linkBaseClass} ${isActive ? activeLinkClass : isSuperAdmin ? inactiveLinkClass : restrictedLinkClass}`}
                                title={!isSuperAdmin ? 'Acceso reservado para Administrador H583623' : undefined}
                            >
                                Ensambles {!isSuperAdmin && <span className="text-[10px] text-amber-400/80">🔒</span>}
                            </NavLink>
                            <NavLink 
                                to="/materials" 
                                className={({ isActive }) => `${linkBaseClass} ${isActive ? activeLinkClass : isSuperAdmin ? inactiveLinkClass : restrictedLinkClass}`}
                                title={!isSuperAdmin ? 'Acceso reservado para Administrador H583623' : undefined}
                            >
                                Materiales {!isSuperAdmin && <span className="text-[10px] text-amber-400/80">🔒</span>}
                            </NavLink>
                            <NavLink 
                                to="/users" 
                                className={({ isActive }) => `${linkBaseClass} ${isActive ? activeLinkClass : isSuperAdmin ? inactiveLinkClass : restrictedLinkClass}`}
                                title={!isSuperAdmin ? 'Acceso reservado para Administrador H583623' : undefined}
                            >
                                Usuarios {!isSuperAdmin && <span className="text-[10px] text-amber-400/80">🔒</span>}
                            </NavLink>
                            <NavLink 
                                to="/vesda-material" 
                                className={({ isActive }) => `${linkBaseClass} ${isActive ? activeLinkClass : isSuperAdmin ? inactiveLinkClass : restrictedLinkClass}`}
                                title={!isSuperAdmin ? 'Acceso reservado para Administrador H583623' : undefined}
                            >
                                VESDA {!isSuperAdmin && <span className="text-[10px] text-amber-400/80">🔒</span>}
                            </NavLink>
                            <NavLink 
                                to="/reports" 
                                className={({ isActive }) => `${linkBaseClass} ${isActive ? activeLinkClass : isSuperAdmin ? inactiveLinkClass : restrictedLinkClass}`}
                                title={!isSuperAdmin ? 'Acceso reservado para Administrador H583623' : undefined}
                            >
                                Reportes {!isSuperAdmin && <span className="text-[10px] text-amber-400/80">🔒</span>}
                            </NavLink>
                            <NavLink 
                                to="/implementation-tasks" 
                                className={({ isActive }) => `${linkBaseClass} ${isActive ? activeLinkClass : isSuperAdmin ? inactiveLinkClass : restrictedLinkClass}`}
                                title={!isSuperAdmin ? 'Acceso reservado para Administrador H583623' : undefined}
                            >
                                Tareas {!isSuperAdmin && <span className="text-[10px] text-amber-400/80">🔒</span>}
                            </NavLink>
                            <NavLink 
                                to="/settings" 
                                className={({ isActive }) => `${linkBaseClass} ${isActive ? activeLinkClass : isSuperAdmin ? inactiveLinkClass : restrictedLinkClass}`}
                                title={!isSuperAdmin ? 'Acceso reservado para Administrador H583623' : undefined}
                            >
                                Configuración {!isSuperAdmin && <span className="text-[10px] text-amber-400/80">🔒</span>}
                            </NavLink>
                        </div>
                        <AzureAuthHeaderWidget />
                        <ThemeSwitcher />
                    </div>
                </div>
            </nav>
        </header>
    );
};

const MainAppContent: React.FC = () => {
    const { currentUser, isSuperAdmin, isAuthEnabled, isLoading: isAuthLoading, loginWithAzure } = useAuth();
    const [users, setUsers] = useState<User[]>([]);
    const [isAppLoading, setIsAppLoading] = useState(true);
    const [loadingError, setLoadingError] = useState<string | null>(null);

    const fetchInitialData = useCallback(async () => {
        setIsAppLoading(true);
        setLoadingError(null);
        try {
            const usersData = await api.getUsers();
            setUsers(usersData);
        } catch (err) {
            console.error("Failed to load initial data:", err);
            setLoadingError(
                "No se pudo conectar con el servidor Backend.\n\n" +
                "1. Asegúrese de haber ejecutado 'npm start' en la carpeta 'backend'.\n" +
                "2. Verifique que la base de datos SQL Server esté corriendo.\n" +
                "3. Revise la consola del servidor para ver errores de conexión."
            );
        } finally {
            setIsAppLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchInitialData();
    }, [fetchInitialData]);

    const onDataChange = useCallback(async () => {
        try {
            const usersData = await api.getUsers();
            setUsers(usersData);
        } catch (err) {
            console.error("Failed to refresh user data:", err);
        }
    }, []);
    
    const handleUserImport = useCallback(async (data: User[], fileName: string) => {
        await api.importUsers(data, fileName);
        await onDataChange();
    }, [onDataChange]);

    const handleUpdateUser = useCallback(async (user: User) => {
        await api.updateUser(user);
        await onDataChange();
    }, [onDataChange]);

    if (isAuthLoading || isAppLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-slate-950">
                <div className="text-center space-y-3">
                    <div className="w-10 h-10 border-3 border-red-600 border-t-transparent rounded-full animate-spin mx-auto"></div>
                    <div className="text-sm font-semibold text-slate-300 font-mono">Cargando Honeywell ECN Manager...</div>
                </div>
            </div>
        );
    }

    if (loadingError && !currentUser) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-slate-950 p-4">
                <Card className="max-w-lg w-full text-center border-destructive bg-slate-900 text-white">
                    <h1 className="text-2xl font-bold text-destructive mb-4">Error de Conexión</h1>
                    <div className="text-left bg-slate-950 p-4 rounded-md text-sm whitespace-pre-line text-slate-300 mb-6">
                        {loadingError}
                    </div>
                    <Button variant="primary" onClick={fetchInitialData}>
                        Intentar de nuevo
                    </Button>
                </Card>
            </div>
        );
    }

    // If Azure authentication is ENABLED and user is not authenticated, display the Login Screen
    // If Azure authentication is DISABLED, start directly in the Dashboard
    if (isAuthEnabled && !currentUser) {
        return <LoginPage onLoginSuccess={() => fetchInitialData()} />;
    }

    return (
        <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <div className="min-h-screen flex flex-col">
                <Header />
                <main className="flex-grow">
                    <div className="max-w-[1800px] w-full mx-auto py-6 px-3 sm:px-6 lg:px-8">
                        <Routes>
                            {/* HOME IS OPEN TO ALL AUTHENTICATED USERS (HID & H583623) */}
                            <Route path="/" element={<Dashboard users={users} />} />
                            
                            {/* PROTECTED ROUTES: EXCLUSIVE FOR ADMIN H583623 */}
                            <Route 
                                path="/changes" 
                                element={isSuperAdmin ? <Changes onDataChange={onDataChange} /> : <AccessDeniedPage requiredFeature="Gestión de Cambios" onOpenChangeUser={() => loginWithAzure()} />} 
                            />
                            <Route 
                                path="/checklist/:ecnId" 
                                element={isSuperAdmin ? <ChecklistPage users={users} /> : <AccessDeniedPage requiredFeature="Checklist de ECN" onOpenChangeUser={() => loginWithAzure()} />} 
                            />
                            <Route 
                                path="/edit/:ecnId" 
                                element={isSuperAdmin ? <EditEcnPage users={users} onDataChange={onDataChange} /> : <AccessDeniedPage requiredFeature="Edición de ECN" onOpenChangeUser={() => loginWithAzure()} />} 
                            />
                            <Route 
                                path="/assemblies" 
                                element={isSuperAdmin ? <AssemblyManagementPage onDataChange={onDataChange} /> : <AccessDeniedPage requiredFeature="Gestión de Ensambles" onOpenChangeUser={() => loginWithAzure()} />} 
                            />
                            <Route 
                                path="/materials" 
                                element={isSuperAdmin ? <MaterialsPage /> : <AccessDeniedPage requiredFeature="Módulo de Materiales" onOpenChangeUser={() => loginWithAzure()} />} 
                            />
                            <Route 
                                path="/users" 
                                element={isSuperAdmin ? <UserManagementPage users={users} onUserImport={handleUserImport} onUpdateUser={handleUpdateUser} /> : <AccessDeniedPage requiredFeature="Administración de Usuarios" onOpenChangeUser={() => loginWithAzure()} />} 
                            />
                            <Route 
                                path="/vesda-material" 
                                element={isSuperAdmin ? <VesdaMaterialPage /> : <AccessDeniedPage requiredFeature="VESDA Material" onOpenChangeUser={() => loginWithAzure()} />} 
                            />
                            <Route 
                                path="/reports" 
                                element={isSuperAdmin ? <ReportsPage /> : <AccessDeniedPage requiredFeature="Reportes" onOpenChangeUser={() => loginWithAzure()} />} 
                            />
                            <Route 
                                path="/implementation-tasks" 
                                element={isSuperAdmin ? <ImplementationTasksPage users={users} /> : <AccessDeniedPage requiredFeature="Tareas de Implementación" onOpenChangeUser={() => loginWithAzure()} />} 
                            />
                            <Route 
                                path="/settings" 
                                element={isSuperAdmin ? <SettingsPage /> : <AccessDeniedPage requiredFeature="Configuración del Sistema" onOpenChangeUser={() => loginWithAzure()} />} 
                            />
                            
                            {/* Fallback */}
                            <Route path="*" element={<Navigate to="/" replace />} />
                        </Routes>
                    </div>
                </main>
                <footer className="w-full bg-card py-4 border-t border-border">
                    <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between text-xs text-muted-foreground gap-2">
                        <div>© 2025 Honeywell ECN Manager • Digital Workplace</div>
                        <div className="flex items-center gap-3">
                            <span>Microsoft Graph Verified</span>
                            <span>•</span>
                            <span>HID Access Policy Active</span>
                        </div>
                    </div>
                </footer>
            </div>
        </HashRouter>
    );
};

const App: React.FC = () => {
    return (
        <AuthProvider>
            <MainAppContent />
        </AuthProvider>
    );
};

export default App;

