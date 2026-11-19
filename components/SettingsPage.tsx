
import React, { useState, useCallback, useEffect, useRef } from 'react';
import * as api from '../services/api';
import { Card, Button, Toast, Modal, ConfirmationModal } from './ui';
import { useAuth } from '../services/authContext';
import { AzureAuthConfig, ServerAuthTestResult, GraphUserLookupResult, AzureUserProfile } from '../types';

interface SettingsPageProps {}

// --- Microsoft Azure / Entra ID Settings Component ---
const AzureAuthSettings: React.FC<{
    setNotification: (n: { message: string, type: 'success' | 'error' } | null) => void;
}> = ({ setNotification }) => {
    const { currentUser, loginWithAzure, loginWithServerToServer, loginWithCorporateEmail, logout, directLogin } = useAuth();
    const [azureConfig, setAzureConfig] = useState<AzureAuthConfig>({
        clientId: 'f3f32c56-7ca8-43ea-ba36-38ea2da0bb34',
        tenantId: '96ece526-9c7d-48b0-8daf-8b93c90a5d18',
        objectId: 'd5bc51c1-2874-475f-8a92-a8a0ec725192',
        redirectUri: '',
        isConfigured: true,
        hasSecret: true,
        appName: 'ECN MANAGER (Server-to-Server App)',
        grantType: 'client_credentials',
        serverToServerEnabled: true,
    });
    const [activeTab, setActiveTab] = useState<'s2s' | 'sso' | 'config'>('s2s');
    const [customClientId, setCustomClientId] = useState('');
    const [customTenantId, setCustomTenantId] = useState('');
    const [clientSecret, setClientSecret] = useState('');
    const [grantTypeSelect, setGrantTypeSelect] = useState<'client_credentials' | 'authorization_code' | 'both'>('client_credentials');
    const [authEnabledToggle, setAuthEnabledToggle] = useState<boolean>(false);
    
    const [isSaving, setIsSaving] = useState(false);
    const [isTestingS2S, setIsTestingS2S] = useState(false);
    const [isConnectingS2S, setIsConnectingS2S] = useState(false);
    const [isLoggingInSSO, setIsLoggingInSSO] = useState(false);
    const [testResult, setTestResult] = useState<ServerAuthTestResult | null>(null);
    const [copiedKey, setCopiedKey] = useState<string | null>(null);

    // Option A: Graph User Lookup State
    const [userQuery, setUserQuery] = useState('beto22mex@gmail.com');
    const [isLookingUpUser, setIsLookingUpUser] = useState(false);
    const [isLoggingInAsUser, setIsLoggingInAsUser] = useState(false);
    const [lookupResult, setLookupResult] = useState<GraphUserLookupResult | null>(null);

    const loadConfig = useCallback(async () => {
        try {
            const config = await api.getAzureAuthConfig();
            setAzureConfig(config);
            setCustomClientId(config.clientId || '');
            setCustomTenantId(config.tenantId || '');
            setAuthEnabledToggle(!!config.authEnabled);
            if (config.grantType) {
                setGrantTypeSelect(config.grantType);
            }
        } catch (e) {
            console.error('Failed to load Azure config:', e);
        }
    }, []);

    useEffect(() => {
        loadConfig();
    }, [loadConfig]);

    const handleCopy = (text: string, key: string) => {
        navigator.clipboard.writeText(text);
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 2000);
        setNotification({ message: 'Texto copiado al portapapeles.', type: 'success' });
    };

    const handleSaveConfig = async () => {
        setIsSaving(true);
        try {
            const payload: any = {
                authEnabled: authEnabledToggle,
                clientId: customClientId.trim() || azureConfig.clientId,
                tenantId: customTenantId.trim() || azureConfig.tenantId,
                grantType: grantTypeSelect,
                serverToServerEnabled: true,
            };
            if (clientSecret.trim()) {
                payload.clientSecret = clientSecret.trim();
            }

            const res = await api.saveAzureConfig(payload);
            setAzureConfig(res.config);
            setAuthEnabledToggle(!!res.config.authEnabled);
            setClientSecret('');
            setNotification({ 
                message: res.config.authEnabled 
                    ? 'Azure AD guardado: Autenticación activada (Inicio en pantalla de Login).' 
                    : 'Azure AD guardado: Modo directo activado (Inicio automático en Dashboard).', 
                type: 'success' 
            });
        } catch (e: any) {
            setNotification({ message: `Error al guardar configuración: ${e.message}`, type: 'error' });
        } finally {
            setIsSaving(false);
        }
    };

    const handleTestServerToServer = async () => {
        setIsTestingS2S(true);
        setTestResult(null);
        try {
            const result = await api.testServerToServerAuth({
                clientId: customClientId.trim() || azureConfig.clientId,
                tenantId: customTenantId.trim() || azureConfig.tenantId,
                clientSecret: clientSecret.trim() || undefined,
            });
            setTestResult(result);
            if (result.success) {
                setNotification({ message: 'Prueba de autenticación Server-to-Server exitosa.', type: 'success' });
            } else {
                setNotification({ message: `Fallo en prueba Server-to-Server: ${result.message || result.error}`, type: 'error' });
            }
        } catch (e: any) {
            setTestResult({
                success: false,
                message: e.message || 'Error desconocido al probar Server-to-Server',
                error: e.message,
            });
            setNotification({ message: `Error: ${e.message}`, type: 'error' });
        } finally {
            setIsTestingS2S(false);
        }
    };

    const handleConnectServerToServer = async () => {
        setIsConnectingS2S(true);
        try {
            const user = await loginWithServerToServer({
                clientId: customClientId.trim() || azureConfig.clientId,
                tenantId: customTenantId.trim() || azureConfig.tenantId,
                clientSecret: clientSecret.trim() || undefined,
            });
            if (user) {
                setNotification({ message: `Conectado exitosamente como ${user.name} (${user.jobTitle})`, type: 'success' });
            }
        } catch (e: any) {
            setNotification({ message: `Error al conectar Server-to-Server: ${e.message}`, type: 'error' });
        } finally {
            setIsConnectingS2S(false);
        }
    };

    const handleLookupUser = async (targetQuery?: string) => {
        const q = (targetQuery || userQuery).trim();
        if (!q) {
            setNotification({ message: 'Ingrese un correo o ID corporativo a consultar.', type: 'error' });
            return;
        }

        setIsLookingUpUser(true);
        setLookupResult(null);
        try {
            const res = await api.lookupAzureUser(q, {
                clientId: customClientId.trim() || azureConfig.clientId,
                tenantId: customTenantId.trim() || azureConfig.tenantId,
                clientSecret: clientSecret.trim() || undefined,
            });
            setLookupResult(res);
            if (res.success && res.found) {
                setNotification({ message: `Usuario encontrado en Microsoft Graph: ${res.user?.displayName}`, type: 'success' });
            } else {
                setNotification({ message: res.message || 'No se encontró el usuario en el directorio.', type: 'error' });
            }
        } catch (err: any) {
            setNotification({ message: `Error al consultar Microsoft Graph: ${err.message}`, type: 'error' });
        } finally {
            setIsLookingUpUser(false);
        }
    };

    const handleLoginAsUser = async (userToUse?: AzureUserProfile) => {
        const target = userToUse || lookupResult?.user;
        const emailOrId = target?.mail || target?.userPrincipalName || userQuery.trim();
        if (!emailOrId) {
            setNotification({ message: 'Ingrese un correo para autenticar.', type: 'error' });
            return;
        }

        setIsLoggingInAsUser(true);
        try {
            const loggedInUser = await loginWithCorporateEmail({
                emailOrId,
                name: target?.displayName,
                department: target?.department,
                jobTitle: target?.jobTitle,
                customConfig: {
                    clientId: customClientId.trim() || azureConfig.clientId,
                    tenantId: customTenantId.trim() || azureConfig.tenantId,
                    clientSecret: clientSecret.trim() || undefined,
                },
            });
            setNotification({ message: `Sesión iniciada con éxito para ${loggedInUser.name} (${loggedInUser.email}).`, type: 'success' });
        } catch (err: any) {
            setNotification({ message: `Error al autenticar usuario: ${err.message}`, type: 'error' });
        } finally {
            setIsLoggingInAsUser(false);
        }
    };

    const handleTestLoginSSO = async () => {
        setIsLoggingInSSO(true);
        try {
            const user = await loginWithAzure();
            if (user) {
                setNotification({ message: `Sesión iniciada como ${user.name} (${user.email}).`, type: 'success' });
            }
        } finally {
            setIsLoggingInSSO(false);
        }
    };

    const handleSimulatedOrgLogin = async () => {
        try {
            await directLogin({
                name: 'Ing. Administrador Honeywell',
                email: 'admin.ecn@honeywell.com',
                department: 'Engineering & Operations',
                jobTitle: 'Lead ECN Coordinator',
            });
            setNotification({ message: 'Sesión de prueba iniciada con perfil corporativo.', type: 'success' });
        } catch (e: any) {
            setNotification({ message: `Error: ${e.message}`, type: 'error' });
        }
    };

    const redirectUrls = [
        { label: 'URL de Desarrollo (Preview)', url: typeof window !== 'undefined' ? `${window.location.origin}/auth/azure/callback` : '/auth/azure/callback', key: 'dev' },
        { label: 'URL Compartida / Producción', url: 'https://ais-pre-txmy2aygnaumy5fu5quqsh-28409889427.us-west1.run.app/auth/azure/callback', key: 'prod' },
        { label: 'URL Local (localhost)', url: 'http://localhost:3000/auth/azure/callback', key: 'local' },
    ];

    return (
        <Card className="border-l-4 border-sky-500 overflow-hidden">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-border">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 grid grid-cols-2 gap-0.5 p-1.5 bg-slate-900 rounded-lg shadow-sm">
                        <div className="bg-[#f25022] rounded-xs"></div>
                        <div className="bg-[#7fba00] rounded-xs"></div>
                        <div className="bg-[#00a4ef] rounded-xs"></div>
                        <div className="bg-[#ffb900] rounded-xs"></div>
                    </div>
                    <div>
                        <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
                            Microsoft Azure / Entra ID Authentication
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse"></span>
                                Server-to-Server Habilitado
                            </span>
                        </h2>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            Autenticación backend-to-backend (Client Credentials) e inicio de sesión SSO con Microsoft Entra ID
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {currentUser ? (
                        <div className="flex items-center gap-3 bg-slate-800/90 px-3.5 py-2 rounded-lg border border-slate-700">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-sky-600 to-blue-500 text-white font-bold flex items-center justify-center text-xs shadow-inner shrink-0">
                                {currentUser.name.charAt(0)}
                            </div>
                            <div className="text-left">
                                <div className="text-xs font-semibold text-white leading-tight">{currentUser.name}</div>
                                <div className="text-[11px] text-sky-300 leading-tight">{currentUser.jobTitle || currentUser.email || 'Autenticado'}</div>
                            </div>
                            <Button variant="secondary" className="!text-xs !py-1 !px-2.5 ml-2" onClick={logout}>
                                Salir
                            </Button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2">
                            <Button
                                variant="primary"
                                onClick={handleConnectServerToServer}
                                disabled={isConnectingS2S}
                                className="!bg-sky-600 hover:!bg-sky-500 text-white flex items-center gap-1.5 !py-2 !px-3 font-semibold text-xs shadow-sm"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
                                </svg>
                                {isConnectingS2S ? 'Conectando...' : 'Conectar Server-to-Server'}
                            </Button>
                        </div>
                    )}
                </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex items-center gap-2 border-b border-border my-4">
                <button
                    onClick={() => setActiveTab('s2s')}
                    className={`pb-2.5 px-3 text-xs font-semibold flex items-center gap-2 border-b-2 transition-colors ${
                        activeTab === 's2s'
                            ? 'border-sky-500 text-sky-400'
                            : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
                    </svg>
                    Server to Server (Client Credentials)
                    <span className="bg-sky-500/20 text-sky-300 text-[10px] px-1.5 py-0.2 rounded font-mono">Activo</span>
                </button>

                <button
                    onClick={() => setActiveTab('sso')}
                    className={`pb-2.5 px-3 text-xs font-semibold flex items-center gap-2 border-b-2 transition-colors ${
                        activeTab === 'sso'
                            ? 'border-sky-500 text-sky-400'
                            : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                    Interactive SSO (Authorization Code)
                </button>

                <button
                    onClick={() => setActiveTab('config')}
                    className={`pb-2.5 px-3 text-xs font-semibold flex items-center gap-2 border-b-2 transition-colors ${
                        activeTab === 'config'
                            ? 'border-sky-500 text-sky-400'
                            : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    Credenciales y Parámetros
                </button>
            </div>

            {/* Selector de Modo: Login Obligatorio vs Modo Directo al Dashboard */}
            <div className={`p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors ${
                authEnabledToggle 
                    ? 'bg-sky-950/40 border-sky-500/40 text-sky-100' 
                    : 'bg-emerald-950/30 border-emerald-500/40 text-emerald-100'
            }`}>
                <div className="space-y-1">
                    <div className="flex items-center gap-2">
                        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${authEnabledToggle ? 'bg-sky-400 animate-pulse' : 'bg-emerald-400'}`}></span>
                        <span className="text-sm font-bold">
                            {authEnabledToggle 
                                ? 'Autenticación Azure AD Habilitada (Inicia en pantalla de Login)' 
                                : 'Autenticación Azure AD Deshabilitada (Inicia directo en Dashboard)'}
                        </span>
                    </div>
                    <p className="text-xs text-slate-300">
                        {authEnabledToggle 
                            ? 'Los usuarios deben iniciar sesión obligatoriamente con Microsoft SSO / Honeywell para ingresar al sistema.' 
                            : 'La aplicación inicia automáticamente en el Dashboard con perfil de Administrador (H583623) sin requerir login.'}
                    </p>
                    <div className="text-[11px] font-mono text-slate-400">
                        Variable en secrets / .env: <span className="text-amber-300 font-bold">AZURE_AUTH_ENABLED={authEnabledToggle ? 'true' : 'false'}</span>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <button
                        type="button"
                        onClick={async () => {
                            const newMode = !authEnabledToggle;
                            setAuthEnabledToggle(newMode);
                            try {
                                const res = await api.saveAzureConfig({
                                    authEnabled: newMode,
                                    clientId: customClientId.trim() || azureConfig.clientId,
                                    tenantId: customTenantId.trim() || azureConfig.tenantId,
                                    grantType: grantTypeSelect,
                                    serverToServerEnabled: true,
                                });
                                setAzureConfig(res.config);
                                setNotification({
                                    message: newMode 
                                        ? 'Autenticación Azure activada: El sistema iniciará en Login.' 
                                        : 'Modo directo activado: El sistema iniciará directamente en el Dashboard.',
                                    type: 'success'
                                });
                            } catch (e: any) {
                                setNotification({ message: `Error: ${e.message}`, type: 'error' });
                            }
                        }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border shadow-sm ${
                            authEnabledToggle
                                ? 'bg-slate-800 text-sky-300 border-sky-400/50 hover:bg-slate-700'
                                : 'bg-emerald-600 text-white border-emerald-400 hover:bg-emerald-500'
                        }`}
                    >
                        {authEnabledToggle ? 'Deshabilitar Login (Modo Directo)' : 'Habilitar Login Azure'}
                    </button>
                </div>
            </div>

            {/* TAB 1: SERVER TO SERVER (CLIENT CREDENTIALS) */}
            {activeTab === 's2s' && (
                <div className="space-y-4">
                    {/* Active Credentials Summary Box */}
                    <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-4 space-y-3">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
                            <div>
                                <span className="text-xs font-bold text-sky-400 uppercase tracking-wider">Flujo de Autenticación Activo</span>
                                <h3 className="text-sm font-semibold text-white mt-0.5">OAuth 2.0 Client Credentials Grant (Server-to-Server)</h3>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-700/50">
                                    grant_type=client_credentials
                                </span>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                            <div className="p-2.5 bg-slate-950/60 rounded border border-slate-800">
                                <span className="text-slate-400 text-[10px] font-bold uppercase block mb-1">Application (Client) ID</span>
                                <div className="font-mono text-sky-300 font-semibold break-all flex items-center justify-between gap-1">
                                    <span>{azureConfig.clientId}</span>
                                    <button
                                        onClick={() => handleCopy(azureConfig.clientId, 'cid')}
                                        className="text-slate-400 hover:text-white p-1"
                                        title="Copiar Client ID"
                                    >
                                        {copiedKey === 'cid' ? '✓' : '📋'}
                                    </button>
                                </div>
                            </div>

                            <div className="p-2.5 bg-slate-950/60 rounded border border-slate-800">
                                <span className="text-slate-400 text-[10px] font-bold uppercase block mb-1">Client Secret Status</span>
                                <div className="font-mono text-emerald-400 font-semibold flex items-center justify-between gap-1">
                                    <span>FMD8Q~d0T...IbpW (Activo)</span>
                                    <span className="text-[10px] bg-emerald-900/60 text-emerald-300 px-1.5 py-0.5 rounded">En Servidor</span>
                                </div>
                            </div>

                            <div className="p-2.5 bg-slate-950/60 rounded border border-slate-800">
                                <span className="text-slate-400 text-[10px] font-bold uppercase block mb-1">Directory (Tenant) ID</span>
                                <div className="font-mono text-slate-200 font-semibold break-all flex items-center justify-between gap-1">
                                    <span>{azureConfig.tenantId}</span>
                                    <button
                                        onClick={() => handleCopy(azureConfig.tenantId, 'tid')}
                                        className="text-slate-400 hover:text-white p-1"
                                        title="Copiar Tenant ID"
                                    >
                                        {copiedKey === 'tid' ? '✓' : '📋'}
                                    </button>
                                </div>
                            </div>

                            <div className="p-2.5 bg-slate-950/60 rounded border border-slate-800">
                                <span className="text-slate-400 text-[10px] font-bold uppercase block mb-1">Default Scope</span>
                                <div className="font-mono text-amber-300 font-semibold break-all">
                                    https://graph.microsoft.com/.default
                                </div>
                            </div>
                        </div>

                        {/* Action Buttons */}
                        <div className="flex flex-wrap items-center gap-3 pt-2">
                            <Button
                                variant="primary"
                                onClick={handleTestServerToServer}
                                disabled={isTestingS2S}
                                className="!bg-sky-600 hover:!bg-sky-500 text-white flex items-center gap-2 !py-2 !px-4 text-xs font-semibold shadow-md"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                                </svg>
                                {isTestingS2S ? 'Verificando con Azure...' : 'Probar Conexión Server-to-Server'}
                            </Button>

                            <Button
                                variant="secondary"
                                onClick={handleConnectServerToServer}
                                disabled={isConnectingS2S}
                                className="!text-xs !py-2 !px-3.5 bg-slate-800 hover:bg-slate-700 text-white flex items-center gap-1.5"
                            >
                                <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                {isConnectingS2S ? 'Conectando...' : 'Iniciar Sesión como Service Principal'}
                            </Button>

                            <Button
                                variant="secondary"
                                onClick={loadConfig}
                                className="!text-xs !py-2 !px-3 ml-auto text-slate-400 hover:text-white"
                            >
                                Refrescar
                            </Button>
                        </div>
                    </div>

                    {/* Server-to-Server Verification Output Terminal / Card */}
                    {testResult && (
                        <div className={`p-4 rounded-lg border text-xs space-y-3 transition-all ${
                            testResult.success
                                ? 'bg-emerald-950/30 border-emerald-600/50 text-emerald-200'
                                : 'bg-red-950/30 border-red-600/50 text-red-200'
                        }`}>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 font-bold text-sm">
                                    {testResult.success ? (
                                        <span className="flex items-center gap-1.5 text-emerald-400">
                                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                            </svg>
                                            Token Server-to-Server Adquirido con Éxito
                                        </span>
                                    ) : (
                                        <span className="flex items-center gap-1.5 text-red-400">
                                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                                            </svg>
                                            Error de Validación de Token
                                        </span>
                                    )}
                                </div>
                                <span className="font-mono text-[11px] opacity-75">{new Date().toLocaleTimeString()}</span>
                            </div>

                            <p className="text-xs leading-relaxed">{testResult.message}</p>

                            {testResult.success && (
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-emerald-700/30 text-[11px] font-mono">
                                    <div className="p-2 bg-black/40 rounded">
                                        <span className="text-slate-400 block text-[10px]">Token Type / Expiración</span>
                                        <span className="text-emerald-300 font-bold">{testResult.tokenType} ({testResult.expiresIn}s)</span>
                                    </div>
                                    <div className="p-2 bg-black/40 rounded">
                                        <span className="text-slate-400 block text-[10px]">App ID Validado</span>
                                        <span className="text-sky-300 font-bold">{testResult.appId}</span>
                                    </div>
                                    <div className="p-2 bg-black/40 rounded">
                                        <span className="text-slate-400 block text-[10px]">Graph API Test</span>
                                        <span className={testResult.graphTest?.success ? 'text-emerald-300 font-bold' : 'text-amber-300 font-bold'}>
                                            {testResult.graphTest?.success ? '✓ Graph Conectado (HTTP 200)' : `HTTP ${testResult.graphTest?.status || 'N/A'}`}
                                        </span>
                                    </div>
                                </div>
                            )}

                            {testResult.error && (
                                <div className="p-2 bg-black/50 rounded font-mono text-[11px] text-red-300 break-all">
                                    {testResult.error}
                                </div>
                            )}
                        </div>
                    )}

                    {/* OPTION A: MICROSOFT GRAPH USER DIRECTORY & AUTHENTICATION */}
                    <div className="bg-slate-900/90 border border-sky-600/40 rounded-lg p-4 space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
                            <div className="flex items-center gap-2.5">
                                <div className="w-7 h-7 rounded-lg bg-sky-950 border border-sky-800 text-sky-400 flex items-center justify-center font-bold text-xs shrink-0">
                                    A
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                                        Opción A: Autenticación de Usuarios vía Microsoft Graph
                                        <span className="text-[10px] bg-sky-500/20 text-sky-300 font-mono px-2 py-0.5 rounded border border-sky-500/30">
                                            Server-to-Server
                                        </span>
                                    </h3>
                                    <p className="text-xs text-slate-400">
                                        El backend usa el token seguro de aplicación para consultar perfiles en Microsoft Entra ID y crear sesiones verificadas.
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Search Bar */}
                        <div className="space-y-2">
                            <label className="block text-xs font-semibold text-slate-200">
                                Correo Honeywell o Identificador de Usuario (UPN / ID):
                            </label>
                            <div className="flex flex-col sm:flex-row gap-2">
                                <div className="relative flex-1">
                                    <input
                                        type="text"
                                        value={userQuery}
                                        onChange={(e) => setUserQuery(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') handleLookupUser(); }}
                                        placeholder="ej. beto22mex@gmail.com o nombre.apellido@honeywell.com"
                                        className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500"
                                    />
                                    <svg className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                    </svg>
                                </div>

                                <Button
                                    variant="secondary"
                                    onClick={() => handleLookupUser()}
                                    disabled={isLookingUpUser || !userQuery.trim()}
                                    className="!text-xs !py-2 !px-4 bg-slate-800 hover:bg-slate-700 text-white font-medium shrink-0 flex items-center gap-1.5"
                                >
                                    {isLookingUpUser ? (
                                        <span className="animate-spin text-sky-400">↻</span>
                                    ) : (
                                        <svg className="w-4 h-4 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 21h7a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v11m0 5l4.879-4.879m0 0a3 3 0 104.243-4.242 3 3 0 00-4.243 4.242z" />
                                        </svg>
                                    )}
                                    {isLookingUpUser ? 'Consultando...' : 'Consultar Microsoft Graph'}
                                </Button>

                                <Button
                                    variant="primary"
                                    onClick={() => handleLoginAsUser()}
                                    disabled={isLoggingInAsUser || !userQuery.trim()}
                                    className="!bg-sky-600 hover:!bg-sky-500 text-white font-semibold !text-xs !py-2 !px-4 shrink-0 flex items-center gap-1.5 shadow-md"
                                >
                                    {isLoggingInAsUser ? (
                                        <span className="animate-spin text-white">↻</span>
                                    ) : (
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                                        </svg>
                                    )}
                                    {isLoggingInAsUser ? 'Autenticando...' : 'Autenticar e Iniciar Sesión'}
                                </Button>
                            </div>
                        </div>

                        {/* Quick Presets for Option A */}
                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                            <span className="text-[10px] uppercase font-bold text-slate-500 mr-1">Pruebas rápidas:</span>
                            {[
                                { label: 'H583623', name: 'Aguilera, Alberto' },
                                { label: 'ALBERTOISAAC.AGUILERA@Honeywell.com', name: 'Aguilera, Alberto' },
                                { label: 'beto22mex@gmail.com', name: 'Aguilera, Alberto' },
                            ].map(item => (
                                <button
                                    key={item.label}
                                    type="button"
                                    onClick={() => {
                                        setUserQuery(item.label);
                                        handleLookupUser(item.label);
                                    }}
                                    className="text-[11px] px-2 py-0.5 rounded bg-slate-950 hover:bg-slate-800 text-sky-300 border border-slate-700/60 font-mono transition-colors"
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>

                        {/* Graph User Lookup Result Card */}
                        {lookupResult && (
                            <div className={`p-3.5 rounded-lg border text-xs space-y-3 animate-in fade-in duration-150 ${
                                lookupResult.found
                                    ? 'bg-slate-950/80 border-emerald-500/40 text-slate-200'
                                    : 'bg-amber-950/30 border-amber-500/40 text-amber-200'
                            }`}>
                                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                                    <div className="flex items-center gap-2 font-semibold text-emerald-400">
                                        <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                                        {lookupResult.found ? 'Perfil Resuelto en Entra ID' : 'Consulta procesada'}
                                    </div>
                                    <span className="font-mono text-[10px] bg-slate-800 px-2 py-0.5 rounded text-slate-300">
                                        Origen: {lookupResult.source === 'microsoft_graph' ? 'Live Microsoft Graph' : 'Directorio Corporativo Honeywell'}
                                    </span>
                                </div>

                                {lookupResult.user && (
                                    <div className="flex items-start gap-3">
                                        <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-sky-600 to-blue-500 text-white font-bold flex items-center justify-center text-sm shadow-md shrink-0 border border-sky-400/30">
                                            {lookupResult.user.displayName.charAt(0).toUpperCase()}
                                        </div>
                                        <div className="min-w-0 flex-1 space-y-1">
                                            <div className="flex items-center justify-between">
                                                <h4 className="text-sm font-bold text-white truncate">{lookupResult.user.displayName}</h4>
                                                <span className="text-[10px] text-emerald-400 font-medium">Cuenta Activa ✓</span>
                                            </div>
                                            <div className="text-[11px] text-sky-300 font-mono">{lookupResult.user.mail || lookupResult.user.userPrincipalName}</div>
                                            <div className="grid grid-cols-2 gap-2 mt-2 text-[11px]">
                                                <div className="bg-slate-900 p-1.5 rounded border border-slate-800">
                                                    <span className="text-slate-400 text-[9px] uppercase font-bold block">Puesto</span>
                                                    <span className="text-slate-200 font-medium">{lookupResult.user.jobTitle || 'ECN Specialist'}</span>
                                                </div>
                                                <div className="bg-slate-900 p-1.5 rounded border border-slate-800">
                                                    <span className="text-slate-400 text-[9px] uppercase font-bold block">Departamento</span>
                                                    <span className="text-slate-200 font-medium">{lookupResult.user.department || 'Honeywell Operations'}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <p className="text-[11px] text-slate-300">{lookupResult.message}</p>

                                {lookupResult.permissionsNote && (
                                    <div className="p-2 bg-amber-950/40 border border-amber-800/40 rounded text-[11px] text-amber-200/90 leading-tight">
                                        {lookupResult.permissionsNote}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* How Server to Server works note */}
                    <div className="bg-muted/30 p-3.5 rounded-lg border border-border text-xs text-muted-foreground space-y-1.5">
                        <span className="font-semibold text-foreground flex items-center gap-1.5">
                            ℹ️ Funcionamiento de la interacción Server-to-Server en Azure Entra ID:
                        </span>
                        <p>
                            El backend solicita tokens de aplicación directamente al endpoint OAuth 2.0 de Microsoft (<span className="font-mono text-sky-400">/oauth2/v2.0/token</span>) utilizando el identificador de cliente <span className="font-mono text-foreground font-semibold">{azureConfig.clientId}</span> y su secreto asignado, sin requerir la intervención de un usuario en navegador.
                        </p>
                    </div>
                </div>
            )}

            {/* TAB 2: INTERACTIVE SSO */}
            {activeTab === 'sso' && (
                <div className="space-y-4">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 bg-muted/40 rounded-lg border border-border">
                        <div>
                            <h4 className="text-sm font-semibold text-foreground">Inicio de Sesión Interactivo de Usuario (SSO)</h4>
                            <p className="text-xs text-muted-foreground">Flujo OAuth 2.0 Authorization Code con Microsoft Entra ID para usuarios individuales.</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="primary"
                                onClick={handleTestLoginSSO}
                                disabled={isLoggingInSSO}
                                className="!bg-[#0078d4] hover:!bg-[#106ebe] text-white flex items-center gap-2 !py-2 !px-3 font-medium text-xs shadow-sm"
                            >
                                <svg className="w-4 h-4" viewBox="0 0 21 21">
                                    <path fill="#f25022" d="M1 1h9v9H1z"/>
                                    <path fill="#00a4ef" d="M1 11h9v9H1z"/>
                                    <path fill="#7fba00" d="M11 1h9v9H11z"/>
                                    <path fill="#ffb900" d="M11 11h9v9H11z"/>
                                </svg>
                                {isLoggingInSSO ? 'Abriendo Azure...' : 'Iniciar Sesión Azure SSO'}
                            </Button>
                            <Button
                                variant="secondary"
                                onClick={handleSimulatedOrgLogin}
                                className="!text-xs !py-2 !px-3"
                                title="Prueba rápida con perfil de usuario corporativo sin salir del portal"
                            >
                                Login Demo
                            </Button>
                        </div>
                    </div>

                    {/* Redirect URIs */}
                    <div className="space-y-2">
                        <span className="text-xs font-semibold text-foreground block">
                            URIs de Redirección Autorizadas para registro en Azure Portal:
                        </span>
                        {redirectUrls.map(({ label, url, key }) => (
                            <div key={key} className="flex items-center justify-between gap-2 p-2.5 rounded-md bg-slate-900/80 border border-slate-800 text-xs">
                                <div className="flex-1 min-w-0">
                                    <span className="text-slate-400 font-medium block text-[11px] mb-0.5">{label}</span>
                                    <span className="font-mono text-sky-300 break-all select-all">{url}</span>
                                </div>
                                <Button
                                    variant="secondary"
                                    className="!py-1 !px-2.5 !text-xs shrink-0 bg-slate-800 hover:bg-slate-700"
                                    onClick={() => handleCopy(url, key)}
                                >
                                    {copiedKey === key ? '¡Copiado!' : 'Copiar URI'}
                                </Button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* TAB 3: CONFIGURATION & CREDENTIALS */}
            {activeTab === 'config' && (
                <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-semibold text-foreground mb-1">
                                Id. de aplicación (Client ID)
                            </label>
                            <input
                                type="text"
                                value={customClientId}
                                onChange={(e) => setCustomClientId(e.target.value)}
                                placeholder="f3f32c56-7ca8-43ea-ba36-38ea2da0bb34"
                                className="block w-full p-2 border border-border rounded-md shadow-sm bg-input text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-sky-500"
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">Identificador de la aplicación registrada en Azure.</p>
                        </div>

                        <div>
                            <label className="block text-xs font-semibold text-foreground mb-1">
                                Id. de directorio (Tenant ID)
                            </label>
                            <input
                                type="text"
                                value={customTenantId}
                                onChange={(e) => setCustomTenantId(e.target.value)}
                                placeholder="96ece526-9c7d-48b0-8daf-8b93c90a5d18"
                                className="block w-full p-2 border border-border rounded-md shadow-sm bg-input text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-sky-500"
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">Directorio de Microsoft Honeywell Entra ID.</p>
                        </div>

                        <div>
                            <label className="block text-xs font-semibold text-foreground mb-1">
                                Client Secret (Valor del Secreto)
                                {azureConfig.hasSecret && (
                                    <span className="ml-2 text-emerald-400 font-normal text-[11px]">✓ Activo en servidor</span>
                                )}
                            </label>
                            <input
                                type="password"
                                value={clientSecret}
                                onChange={(e) => setClientSecret(e.target.value)}
                                placeholder={azureConfig.hasSecret ? '•••••••••••••••••••••••• (Secreto configurado)' : 'Ingrese el secreto de la aplicacion'}
                                className="block w-full p-2 border border-border rounded-md shadow-sm bg-input text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-sky-500"
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">Secret ID/Value para autenticación Server-to-Server.</p>
                        </div>

                        <div>
                            <label className="block text-xs font-semibold text-foreground mb-1">
                                Tipo de Concesión Predeterminado (Grant Type)
                            </label>
                            <select
                                value={grantTypeSelect}
                                onChange={(e) => setGrantTypeSelect(e.target.value as any)}
                                className="block w-full p-2 border border-border rounded-md shadow-sm bg-input text-foreground text-xs font-medium focus:outline-none focus:ring-1 focus:ring-sky-500"
                            >
                                <option value="client_credentials">Server-to-Server (client_credentials)</option>
                                <option value="authorization_code">Interactive SSO (authorization_code)</option>
                                <option value="both">Híbrido (Ambos disponibles)</option>
                            </select>
                            <p className="text-[10px] text-muted-foreground mt-1">Define el método de autenticación preferido.</p>
                        </div>
                    </div>

                    <div className="pt-3 border-t border-border flex items-center justify-end gap-3">
                        <Button
                            variant="secondary"
                            onClick={loadConfig}
                            className="!text-xs !py-2"
                        >
                            Descartar Cambios
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleSaveConfig}
                            disabled={isSaving}
                            className="!text-xs !py-2 !px-4"
                        >
                            {isSaving ? 'Guardando...' : 'Guardar Parámetros en Servidor'}
                        </Button>
                    </div>
                </div>
            )}
        </Card>
    );
};


// --- Email Settings Component ---
const EmailSettings: React.FC<{
    setNotification: (n: { message: string, type: 'success' | 'error' } | null) => void;
}> = ({ setNotification }) => {
    const [settings, setSettings] = useState<api.EmailSettings>({
        host: '', port: 587, user: '', pass: '', from: '', fromName: 'ECN Manager', to: '', secure: false
    });
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [isTesting, setIsTesting] = useState(false);

    useEffect(() => {
        const fetchSettings = async () => {
            setIsLoading(true);
            try {
                const existingSettings = await api.getEmailSettings();
                setSettings(s => ({ ...s, ...existingSettings }));
            } catch (error) {
                console.error("Failed to load email settings:", error);
                setNotification({ message: 'No se pudo cargar la configuración de correo.', type: 'error' });
            } finally {
                setIsLoading(false);
            }
        };
        fetchSettings();
    }, [setNotification]);
    
    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { name, value, type } = e.target;
        let finalValue: any = value;
        if (type === 'number') finalValue = parseInt(value, 10);
        if (type === 'checkbox') finalValue = (e.target as HTMLInputElement).checked;
        
        setSettings(prev => ({ ...prev, [name]: finalValue }));
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            await api.saveEmailSettings(settings);
            setNotification({ message: 'Configuración de correo guardada.', type: 'success' });
        } catch (error) {
            console.error("Failed to save email settings:", error);
            setNotification({ message: (error as Error).message, type: 'error' });
        } finally {
            setIsSaving(false);
        }
    };
    
    const handleTest = async () => {
        setIsTesting(true);
        try {
            await api.testEmailSettings(settings);
            setNotification({ message: `Correo de prueba enviado a ${settings.to}.`, type: 'success' });
        } catch (error) {
            console.error("Failed to send test email:", error);
            setNotification({ message: (error as Error).message, type: 'error' });
        } finally {
            setIsTesting(false);
        }
    };

    const inputClass = "block w-full p-2 border border-border rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-ring bg-input text-foreground text-sm";
    const labelClass = "block text-sm font-medium text-foreground mb-1";
    
    if (isLoading) {
        return <Card>Cargando configuración de correo...</Card>;
    }

    return (
        <Card>
            <h2 className="text-xl font-semibold text-foreground">Configuración de Correo Electrónico</h2>
            <p className="text-sm text-muted-foreground my-2">
                Configure el servidor SMTP para enviar notificaciones por correo cuando cambie el estado de un ECN.
            </p>
            <div className="space-y-4 mt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label htmlFor="host" className={labelClass}>Host SMTP</label>
                        <input id="host" name="host" type="text" value={settings.host} onChange={handleChange} className={inputClass} placeholder="smtp.example.com" />
                    </div>
                    <div>
                        <label htmlFor="port" className={labelClass}>Puerto SMTP</label>
                        <input id="port" name="port" type="number" value={settings.port} onChange={handleChange} className={inputClass} placeholder="587" />
                    </div>
                </div>
                <div className="flex items-center mt-2 mb-2">
                    <input 
                        id="secure" 
                        name="secure" 
                        type="checkbox" 
                        checked={settings.secure} 
                        onChange={handleChange} 
                        className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded bg-input"
                    />
                    <label htmlFor="secure" className="ml-2 block text-sm text-foreground">
                        Conexión Segura (SSL/TLS) - <i>Marcar si usa puerto 465</i>
                    </label>
                </div>
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label htmlFor="user" className={labelClass}>Usuario SMTP</label>
                        <input id="user" name="user" type="text" value={settings.user} onChange={handleChange} className={inputClass} placeholder="usuario@example.com" />
                    </div>
                    <div>
                        <label htmlFor="pass" className={labelClass}>Contraseña SMTP</label>
                        <input id="pass" name="pass" type="password" value={settings.pass} onChange={handleChange} className={inputClass} />
                    </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label htmlFor="from" className={labelClass}>Correo del Remitente</label>
                        <input id="from" name="from" type="email" value={settings.from} onChange={handleChange} className={inputClass} placeholder="noreply@example.com" />
                    </div>
                    <div>
                        <label htmlFor="fromName" className={labelClass}>Nombre del Remitente</label>
                        <input id="fromName" name="fromName" type="text" value={settings.fromName} onChange={handleChange} className={inputClass} placeholder="ECN Manager" />
                    </div>
                </div>
                 <div>
                    <label htmlFor="to" className={labelClass}>Correos de Destinatarios</label>
                    <textarea id="to" name="to" value={settings.to} onChange={handleChange} className={inputClass} rows={3} placeholder="separados por comas: ing1@example.com, ing2@example.com"/>
                    <p className="text-xs text-muted-foreground mt-1">Lista de correos, separados por comas, que recibirán las notificaciones.</p>
                </div>
            </div>
            <div className="mt-6 flex justify-end space-x-2">
                <Button variant="secondary" onClick={handleTest} disabled={isTesting || isSaving}>
                    {isTesting ? 'Enviando...' : 'Enviar Correo de Prueba'}
                </Button>
                <Button variant="primary" onClick={handleSave} disabled={isSaving || isTesting}>
                    {isSaving ? 'Guardando...' : 'Guardar Configuración'}
                </Button>
            </div>
        </Card>
    );
};

const WeeklyReportSettings: React.FC<{
    setNotification: (n: { message: string, type: 'success' | 'error' } | null) => void;
}> = ({ setNotification }) => {
    const [isSending, setIsSending] = useState(false);

    const handleSendSummary = async () => {
        setIsSending(true);
        try {
            const result = await api.sendWeeklySummary();
            setNotification({ message: result.message || 'Solicitud enviada.', type: 'success' });
        } catch (error) {
            console.error("Failed to send weekly summary:", error);
            setNotification({ message: (error as Error).message, type: 'error' });
        } finally {
            setIsSending(false);
        }
    };

    return (
        <Card>
            <h2 className="text-xl font-semibold text-foreground">Reportes por Correo</h2>
            <p className="text-sm text-muted-foreground my-2">
                Genere y envíe reportes por correo a la lista de destinatarios configurada.
            </p>
             <div className="mt-4">
                <h3 className="text-lg font-medium text-foreground">Resumen Semanal</h3>
                <p className="text-sm text-muted-foreground mt-1 mb-3">
                    Envíe un resumen de los ECNs implementados en la última semana y los que se implementarán en los próximos 15 días.
                </p>
                <Button variant="primary" onClick={handleSendSummary} disabled={isSending}>
                    {isSending ? 'Enviando...' : 'Enviar Resumen Semanal Ahora'}
                </Button>
            </div>
        </Card>
    );
};

// --- Postgres Migration Component ---
const PostgresMigration: React.FC<{
    setNotification: (n: { message: string, type: 'success' | 'error' } | null) => void;
}> = ({ setNotification }) => {
    const [pgConfig, setPgConfig] = useState({
        user: 'postgres',
        password: '',
        host: 'localhost',
        port: 5432,
        database: 'postgres',
        ssl: false
    });
    const [isMigrating, setIsMigrating] = useState(false);
    const [logs, setLogs] = useState<string[]>([]);
    const logContainerRef = useRef<HTMLDivElement>(null);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value, type, checked } = e.target;
        setPgConfig(prev => ({
            ...prev,
            [name]: type === 'checkbox' ? checked : (name === 'port' ? parseInt(value) : value)
        }));
    };

    useEffect(() => {
        if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
        }
    }, [logs]);

    const handleMigrate = async () => {
        setIsMigrating(true);
        setLogs(['Iniciando proceso de migración...']);
        setNotification(null);
        
        try {
            const response = await api.migrateFromPostgresStream(pgConfig);
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.includes("text/html")) {
                const text = await response.text();
                const titleMatch = text.match(/<title>(.*?)<\/title>/i);
                const title = titleMatch ? titleMatch[1] : "Error HTML desconocido";
                throw new Error(`El servidor devolvió una página HTML en lugar de datos. Detalle: ${title}`);
            }

            if (!response.ok) throw new Error(`Error de conexión al servidor: ${response.status} ${response.statusText}`);
            if (!response.body) throw new Error("El servidor no devolvió una respuesta válida (body vacío).");

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || ""; 

                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const data = JSON.parse(line);
                            setLogs(prev => [...prev, `[${data.step}] ${data.message}`]);
                            if (data.step === 'ERROR') setNotification({ message: 'La migración se detuvo con errores.', type: 'error' });
                        } catch (e) {
                            console.error("Error parsing stream JSON line:", line, e);
                            setLogs(prev => [...prev, `[RAW] ${line}`]);
                        }
                    }
                }
            }
            setNotification({ message: 'Proceso finalizado. Revise los logs.', type: 'success' });
        } catch (error) {
            console.error("Migration failed:", error);
            setLogs(prev => [...prev, `[ERROR CRÍTICO] ${(error as Error).message}`]);
            setNotification({ message: 'Error en la migración. Revise la consola y logs.', type: 'error' });
        } finally {
            setIsMigrating(false);
        }
    };

    const inputClass = "block w-full p-2 border border-border rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-ring bg-input text-foreground text-sm";
    const labelClass = "block text-sm font-medium text-foreground mb-1";

    return (
        <Card className="border-l-4 border-blue-500">
            <h2 className="text-xl font-semibold text-foreground">Migración Directa desde PostgreSQL</h2>
            <p className="text-sm text-muted-foreground my-2">
                Conecte directamente a una base de datos PostgreSQL antigua y transfiera los datos. Útil si tiene acceso directo al servidor de BD.
            </p>
            <div className="space-y-4 mt-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                        <label className={labelClass}>Host (Origen)</label>
                        <input name="host" value={pgConfig.host} onChange={handleChange} className={inputClass} />
                    </div>
                    <div>
                        <label className={labelClass}>Puerto</label>
                        <input name="port" type="number" value={pgConfig.port} onChange={handleChange} className={inputClass} />
                    </div>
                    <div>
                        <label className={labelClass}>Base de Datos</label>
                        <input name="database" value={pgConfig.database} onChange={handleChange} className={inputClass} />
                    </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label className={labelClass}>Usuario</label>
                        <input name="user" value={pgConfig.user} onChange={handleChange} className={inputClass} />
                    </div>
                    <div>
                        <label className={labelClass}>Contraseña</label>
                        <input name="password" type="password" value={pgConfig.password} onChange={handleChange} className={inputClass} />
                    </div>
                </div>
                <div className="flex items-center mt-2">
                    <input id="ssl" name="ssl" type="checkbox" checked={pgConfig.ssl} onChange={handleChange} className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded" />
                    <label htmlFor="ssl" className="ml-2 block text-sm text-foreground">Usar SSL (Obligatorio para Azure/AWS)</label>
                </div>
            </div>
            
            <div className="mt-6 bg-black rounded-lg p-4 font-mono text-xs md:text-sm h-64 overflow-y-auto text-green-400 border border-gray-700 shadow-inner" ref={logContainerRef}>
                {logs.length === 0 ? <span className="text-gray-500">Log de migración...</span> : logs.map((log, index) => (
                    <div key={index} className="mb-1 border-b border-gray-800 pb-1 last:border-0 break-all">
                        <span className="text-blue-400 mr-2">{new Date().toLocaleTimeString()}</span>{log}
                    </div>
                ))}
                 {isMigrating && <div className="animate-pulse mt-2">_ Procesando...</div>}
            </div>

            <div className="mt-4">
                <Button variant="primary" onClick={handleMigrate} disabled={isMigrating}>
                    {isMigrating ? 'Migrando...' : 'Iniciar Migración DB'}
                </Button>
            </div>
        </Card>
    );
};

// --- Api Migration Component ---
const ApiMigration: React.FC<{
    setNotification: (n: { message: string, type: 'success' | 'error' } | null) => void;
}> = ({ setNotification }) => {
    const [sourceUrl, setSourceUrl] = useState('');
    const [isMigrating, setIsMigrating] = useState(false);
    const [logs, setLogs] = useState<string[]>([]);
    const logContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (logContainerRef.current) logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }, [logs]);

    const handleMigrate = async () => {
        setIsMigrating(true);
        setLogs(['Iniciando migración vía API...']);
        setNotification(null);
        
        try {
            const response = await api.migrateFromApiStream(sourceUrl);
            
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.includes("text/html")) {
                 throw new Error(`El servidor devolvió error HTML (404/500). Verifique URL.`);
            }

            if (!response.ok) throw new Error(`Error de conexión: ${response.status}`);
            if (!response.body) throw new Error("Respuesta vacía del servidor.");

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || ""; 

                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const data = JSON.parse(line);
                            setLogs(prev => [...prev, `[${data.step}] ${data.message}`]);
                            if (data.step === 'ERROR') setNotification({ message: 'Error en migración API.', type: 'error' });
                        } catch (e) {
                            console.error("Parsing Error:", line, e);
                        }
                    }
                }
            }
            setNotification({ message: 'Migración API finalizada.', type: 'success' });
        } catch (error) {
            console.error("Migration failed:", error);
            setLogs(prev => [...prev, `[ERROR] ${(error as Error).message}`]);
            setNotification({ message: 'Falló la migración API.', type: 'error' });
        } finally {
            setIsMigrating(false);
        }
    };

    return (
        <Card className="border-l-4 border-purple-500">
            <h2 className="text-xl font-semibold text-foreground">Migración desde API Remota</h2>
            <p className="text-sm text-muted-foreground my-2">
                Importa datos conectándose a la API REST de la aplicación antigua. Útil si no tiene acceso directo a la base de datos pero la API es pública.
            </p>
            <div className="mt-4">
                <label className="block text-sm font-medium text-foreground mb-1">URL de la API Origen</label>
                <input 
                    value={sourceUrl} 
                    onChange={e => setSourceUrl(e.target.value)} 
                    className="block w-full p-2 border border-border rounded-md shadow-sm bg-input text-foreground text-sm" 
                    placeholder="https://vieja-app.com/api"
                />
            </div>
            
            <div className="mt-6 bg-black rounded-lg p-4 font-mono text-xs md:text-sm h-64 overflow-y-auto text-purple-400 border border-gray-700 shadow-inner" ref={logContainerRef}>
                {logs.length === 0 ? <span className="text-gray-500">Esperando...</span> : logs.map((log, index) => (
                    <div key={index} className="mb-1 border-b border-gray-800 pb-1 last:border-0 break-all">
                        <span className="text-blue-400 mr-2">{new Date().toLocaleTimeString()}</span>{log}
                    </div>
                ))}
                 {isMigrating && <div className="animate-pulse mt-2">_ Descargando datos...</div>}
            </div>

            <div className="mt-4">
                <Button variant="primary" onClick={handleMigrate} disabled={isMigrating}>
                    {isMigrating ? 'Migrando...' : 'Iniciar Migración API'}
                </Button>
            </div>
        </Card>
    );
};

const SettingsPage: React.FC<SettingsPageProps> = () => {
    const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
    const [confirmation, setConfirmation] = useState<{ title: string; message: React.ReactNode; onConfirm: () => void } | null>(null);
    const [isAboutModalOpen, setIsAboutModalOpen] = useState(false);
    
    const handleClearData = async () => {
        try {
            await api.clearAllData();
            setNotification({ message: 'Todos los datos han sido eliminados del servidor.', type: 'success' });
        } catch (err) {
            setNotification({ message: (err as Error).message || "Ocurrió un error al limpiar los datos.", type: 'error' });
        } finally {
            setConfirmation(null);
        }
    };

    return (
        <div className="space-y-6">
            {notification && <Toast message={notification.message} type={notification.type} onClose={() => setNotification(null)} />}
            <h1 className="text-3xl font-bold text-foreground">Configuración y Administración</h1>

            {/* Microsoft Azure / Entra ID SSO */}
            <AzureAuthSettings setNotification={setNotification} />

            <Card>
                <h2 className="text-xl font-semibold text-foreground">Acerca de la Aplicación</h2>
                <div className="mt-4">
                    <Button variant="secondary" onClick={() => setIsAboutModalOpen(true)}>Mostrar Información</Button>
                </div>
            </Card>

            <EmailSettings setNotification={setNotification} />
            <WeeklyReportSettings setNotification={setNotification} />
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <PostgresMigration setNotification={setNotification} />
                <ApiMigration setNotification={setNotification} />
            </div>

            <Card className="border-l-4 border-destructive">
                <h2 className="text-xl font-semibold text-foreground">Gestión de Datos</h2>
                <p className="text-sm text-muted-foreground my-2">
                    Eliminar todos los datos de la base de datos actual (MS SQL Server).
                </p>
                <div className="mt-4">
                     <Button 
                        variant="danger" 
                        onClick={() => setConfirmation({
                            title: 'Confirmar Limpieza Total',
                            message: (
                                <div>
                                    <p className="font-bold text-destructive">¡ADVERTENCIA!</p>
                                    <p>Eliminará permanentemente TODOS los datos de la base de datos MS SQL.</p>
                                    <p>¿Está seguro?</p>
                                </div>
                            ),
                            onConfirm: handleClearData
                        })}
                    >
                        Limpiar Todos los Datos
                    </Button>
                </div>
            </Card>

            <Modal isOpen={isAboutModalOpen} onClose={() => setIsAboutModalOpen(false)} title="Acerca de ECN Manager">
                <div className="space-y-4 text-muted-foreground">
                    <div><span className="font-semibold text-foreground mr-2">Versión Backend:</span> MS SQL Server 2014 Edition</div>
                </div>
                <div className="mt-6 flex justify-end">
                    <Button onClick={() => setIsAboutModalOpen(false)}>Cerrar</Button>
                </div>
            </Modal>
            
            {confirmation && (
                <ConfirmationModal
                    isOpen={!!confirmation}
                    onClose={() => setConfirmation(null)}
                    onConfirm={confirmation.onConfirm}
                    title={confirmation.title}
                    message={confirmation.message}
                />
            )}
        </div>
    );
};

export default SettingsPage;
