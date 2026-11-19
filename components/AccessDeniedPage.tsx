import React from 'react';
import { useAuth } from '../services/authContext';
import { NavLink } from 'react-router-dom';
import { Button } from './ui';

interface AccessDeniedPageProps {
    requiredFeature?: string;
    onOpenChangeUser?: () => void;
}

export const AccessDeniedPage: React.FC<AccessDeniedPageProps> = ({ 
    requiredFeature = 'esta sección',
    onOpenChangeUser
}) => {
    const { currentUser, logout } = useAuth();

    return (
        <div className="min-h-[70vh] flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-slate-900 border border-amber-500/40 rounded-2xl p-6 shadow-2xl text-center space-y-5">
                <div className="w-16 h-16 bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-2xl flex items-center justify-center mx-auto shadow-inner">
                    <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                </div>

                <div className="space-y-2">
                    <span className="text-[10px] font-bold tracking-widest uppercase bg-amber-500/20 text-amber-300 border border-amber-500/30 px-3 py-1 rounded-full">
                        Acceso Restringido por Política
                    </span>
                    <h2 className="text-xl font-bold text-white tracking-tight">
                        Acceso Exclusivo a Pantalla Home
                    </h2>
                    <p className="text-xs text-slate-400 leading-relaxed">
                        Tu cuenta actual con <strong className="text-slate-200">HID: {currentUser?.hid || currentUser?.id || 'Desconocido'}</strong> tiene permisos únicamente para consultar el tablero principal <strong>Home</strong>.
                    </p>
                </div>

                <div className="p-3.5 bg-slate-950/80 rounded-xl border border-slate-800 text-left text-xs space-y-2">
                    <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-400">Usuario Autenticado:</span>
                        <span className="text-white font-semibold font-mono">{currentUser?.name || currentUser?.email}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-400">Nivel de Acceso:</span>
                        <span className="text-sky-300 font-mono bg-sky-950/60 px-2 py-0.5 rounded border border-sky-800/40">
                            Solo Pantalla Home
                        </span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] pt-1 border-t border-slate-800/80">
                        <span className="text-slate-400">Permiso requerido:</span>
                        <span className="text-emerald-400 font-mono font-bold">
                            ID H583623 (Super Admin)
                        </span>
                    </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-2 pt-2">
                    <NavLink to="/" className="flex-1">
                        <Button variant="primary" className="w-full !bg-red-600 hover:!bg-red-500 !text-xs !py-2.5 font-bold shadow-md">
                            Volver a Pantalla Home
                        </Button>
                    </NavLink>
                    <Button 
                        variant="secondary" 
                        onClick={() => {
                            if (onOpenChangeUser) {
                                onOpenChangeUser();
                            } else {
                                logout();
                            }
                        }}
                        className="!text-xs !py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center justify-center gap-1.5"
                    >
                        <span>Cambiar Cuenta (Microsoft SSO)</span>
                    </Button>
                </div>
            </div>
        </div>
    );
};
