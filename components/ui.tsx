import React, { ReactNode, useEffect, useState } from 'react';
import { ECNStatus, User } from '../types';

// --- Card ---
interface CardProps {
    children: ReactNode;
    className?: string;
}
export const Card: React.FC<CardProps> = ({ children, className = '' }) => (
    <div className={`bg-card text-card-foreground shadow-sm rounded-lg border border-border p-6 ${className}`}>
        {children}
    </div>
);

// --- Button ---
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'danger';
    children: ReactNode;
}
export const Button: React.FC<ButtonProps> = ({ children, variant = 'secondary', ...props }) => {
    const baseClasses = "px-4 py-2 rounded-md text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ring transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
    const variantClasses = {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        danger: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    };
    return (
        <button className={`${baseClasses} ${variantClasses[variant]}`} {...props}>
            {children}
        </button>
    );
};

// --- Modal ---
interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: ReactNode;
    children: ReactNode;
    size?: 'md' | 'lg' | 'xl' | '2xl' | 'full' | 'screen';
}
export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, size = 'lg' }) => {
    if (!isOpen) return null;

    const sizeClasses = {
        md: 'max-w-md',
        lg: 'max-w-lg',
        xl: 'max-w-xl',
        '2xl': 'max-w-2xl',
        'full': 'max-w-6xl',
        'screen': 'max-w-screen-xl'
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex justify-center items-center p-4" onClick={onClose}>
            <div className={`bg-background rounded-lg shadow-xl w-full ${sizeClasses[size]} flex flex-col`} onClick={e => e.stopPropagation()}>
                <div className="flex justify-between items-center p-4 border-b border-border">
                    <h2 className="text-xl font-semibold text-foreground">{title}</h2>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </div>
                <div className="p-6 overflow-y-auto" style={{maxHeight: '80vh'}}>
                    {children}
                </div>
            </div>
        </div>
    );
};

// --- Toast Notification ---
interface ToastProps {
    message: string;
    type: 'success' | 'error';
    onClose: () => void;
}
export const Toast: React.FC<ToastProps> = ({ message, type, onClose }) => {
    const baseClasses = "fixed top-5 right-5 z-[100] p-4 rounded-md shadow-lg flex items-center space-x-4 max-w-sm animate-fade-in-right border";
    const typeClasses = {
        success: 'bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-300',
        error: 'bg-destructive/10 border-destructive/30 text-destructive dark:text-red-400',
    };
    
    const Icon = () => {
        if (type === 'success') {
            return <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>;
        }
        return <svg className="w-6 h-6 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>;
    }

    useEffect(() => {
        const timer = setTimeout(() => {
            onClose();
        }, 5000); // Auto-dismiss after 5 seconds
        return () => clearTimeout(timer);
    }, [onClose]);

    return (
        <div className={`${baseClasses} ${typeClasses[type]}`}>
            <div className="flex-shrink-0">
                <Icon />
            </div>
            <div className="flex-1">
                <p className="text-sm font-medium">{type === 'success' ? 'Éxito' : 'Error'}</p>
                <p className="text-sm">{message}</p>
            </div>
             <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 rounded-full hover:bg-muted">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
        </div>
    );
};


// --- StatusBadge ---
interface StatusBadgeProps {
    status: ECNStatus;
}
export const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
    const statusClasses = {
        [ECNStatus.Pending]: 'bg-yellow-500/20 text-brand-pending',
        [ECNStatus.Implemented]: 'bg-green-500/20 text-brand-implemented',
        [ECNStatus.Canceled]: 'bg-destructive/20 text-destructive',
        [ECNStatus.PartialImplemented]: 'bg-blue-500/20 text-brand-partial',
    };
    return <span className={`px-2 py-1 text-xs font-semibold rounded-full ${statusClasses[status]}`}>{status}</span>;
};

// --- Pagination ---
interface PaginationProps {
    currentPage: number;
    totalPages: number;
    onPageChange: (page: number) => void;
}

export const Pagination: React.FC<PaginationProps> = ({ currentPage, totalPages, onPageChange }) => {
    if (totalPages <= 1) return null;
    return (
        <div className="flex justify-end items-center space-x-2 mt-4">
            <Button onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1}>
                Anterior
            </Button>
            <span className="text-sm text-muted-foreground">
                Página {currentPage} de {totalPages}
            </span>
            <Button onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === totalPages}>
                Siguiente
            </Button>
        </div>
    );
};

// --- Confirmation Modal ---
interface ConfirmationModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: React.ReactNode;
    confirmText?: string;
    cancelText?: string;
}

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText = 'Confirmar',
    cancelText = 'Cancelar'
}) => {
    if (!isOpen) return null;

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={title} size="md">
            <div className="text-muted-foreground">{message}</div>
            <div className="mt-6 flex justify-end space-x-2">
                <Button variant="secondary" onClick={onClose}>{cancelText}</Button>
                <Button variant="primary" onClick={onConfirm}>{confirmText}</Button>
            </div>
        </Modal>
    );
};

// --- User Profile ---
interface UserProfileProps {
    user: User | { id: string; name: string; email?: string; photo?: string; };
    size?: 'sm' | 'md';
}

export const UserProfile: React.FC<UserProfileProps> = ({ user, size = 'sm' }) => {
    // State to track loading errors for each potential image source.
    const [base64Error, setBase64Error] = useState(false);
    const [sharepointError, setSharepointError] = useState(false);

    // Extract photo data from the user prop.
    const base64Photo = (user as User).photo;
    const sharepointUrl = user.email ? `https://honeywellprod.sharepoint.com/_layouts/15/userphoto.aspx?size=S&accountname=${user.email}` : '';

    // When the user prop changes, reset the error flags to re-attempt loading images.
    useEffect(() => {
        setBase64Error(false);
        setSharepointError(false);
    }, [user.id, user.email, base64Photo]);

    const sizeClasses = {
        sm: 'h-6 w-6',
        md: 'h-8 w-8',
    };

    const textClasses = {
        sm: 'text-sm',
        md: 'text-base',
    };

    const FallbackIcon = () => (
        <span className={`inline-flex items-center justify-center ${sizeClasses[size]} rounded-full overflow-hidden bg-muted`}>
            <svg className="h-full w-full text-muted-foreground" fill="currentColor" viewBox="0 0 24 24">
                <path d="M24 20.993V24H0v-2.996A14.977 14.977 0 0112.004 15c4.904 0 9.26 2.354 11.996 5.993zM16.002 8.999a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
        </span>
    );
    
    /**
     * Safely constructs a data URI from a base64 string.
     * It handles cases where the prefix is already included and trims whitespace.
     */
    const getSafeBase64Src = () => {
        if (!base64Photo || typeof base64Photo !== 'string') return '';
        const trimmedPhoto = base64Photo.trim();
        // If the string is already a data URI, use it directly.
        if (trimmedPhoto.startsWith('data:image')) {
            return trimmedPhoto;
        }
        // Otherwise, assume it's a raw base64 string and add the JPEG prefix.
        return `data:image/jpeg;base64,${trimmedPhoto}`;
    };

    const renderImage = () => {
        // Priority 1: Base64 Photo from DB
        // Attempt to render from Base64 string if available and it hasn't failed before.
        if (base64Photo && !base64Error) {
            return (
                <img
                    className={`${sizeClasses[size]} rounded-full object-cover`}
                    src={getSafeBase64Src()}
                    alt={`Foto de perfil de ${user.name}`}
                    // If this image fails to load, set the error flag. This will trigger a re-render,
                    // which will then attempt the next source in the fallback chain.
                    onError={() => setBase64Error(true)}
                />
            );
        }

        // Priority 2: SharePoint Photo (Fallback for missing or broken base64)
        // This runs if the base64 photo is missing or if it failed to load.
        if (sharepointUrl && !sharepointError) {
             return (
                <img
                    className={`${sizeClasses[size]} rounded-full object-cover`}
                    src={sharepointUrl}
                    alt={`Foto de perfil de ${user.name}`}
                    // If the SharePoint image also fails, set its error flag.
                    // The next re-render will hit the final fallback icon.
                    onError={() => setSharepointError(true)}
                />
            );
        }

        // Priority 3: Final Fallback Icon
        // This ensures a broken image placeholder is never permanently shown.
        return <FallbackIcon />;
    };

    return (
        <div className="flex items-center space-x-2">
            {renderImage()}
            <span className={`${textClasses[size]} text-muted-foreground`}>{user.name || user.id}</span>
        </div>
    );
};

// --- Import Progress Modal ---
export interface ImportProgressModalProps {
    isOpen: boolean;
    percent: number;
    stage?: string;
    current?: number;
    total?: number;
    newCount?: number;
    updatedCount?: number;
    title?: string;
}

export const ImportProgressModal: React.FC<ImportProgressModalProps> = ({
    isOpen,
    percent,
    stage = 'Procesando importación...',
    current,
    total,
    newCount,
    updatedCount,
    title = 'Importando Datos a la Base de Datos'
}) => {
    if (!isOpen) return null;

    const clampedPercent = Math.min(100, Math.max(0, Math.round(percent)));

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex justify-center items-center p-4">
            <div className="bg-card text-card-foreground rounded-xl shadow-2xl border border-border max-w-lg w-full p-6 space-y-5">
                {/* Header with animated pulse and spinner */}
                <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-full bg-brand-red/10 flex items-center justify-center text-brand-red">
                        <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                        </svg>
                    </div>
                    <div className="flex-1">
                        <h3 className="text-base font-bold text-foreground">{title}</h3>
                        <p className="text-xs text-muted-foreground">Por favor no cierre la ventana mientras se procesa la información.</p>
                    </div>
                    <div className="text-right">
                        <span className="text-2xl font-black text-brand-red">{clampedPercent}%</span>
                    </div>
                </div>

                {/* Main Progress Bar */}
                <div className="space-y-2">
                    <div className="w-full bg-secondary rounded-full h-4 overflow-hidden p-0.5 shadow-inner border border-border/50">
                        <div 
                            className="bg-gradient-to-r from-red-600 via-brand-red to-orange-500 h-full rounded-full transition-all duration-300 ease-out shadow-sm relative overflow-hidden"
                            style={{ width: `${clampedPercent}%` }}
                        >
                            <div className="absolute inset-0 bg-white/20 w-full animate-pulse"></div>
                        </div>
                    </div>
                    <div className="flex justify-between items-center text-xs text-muted-foreground font-medium">
                        <span className="truncate max-w-[70%]">{stage}</span>
                        {total !== undefined && total > 0 ? (
                            <span className="font-semibold text-foreground shrink-0">
                                {current ?? 0} / {total} ECNs
                            </span>
                        ) : null}
                    </div>
                </div>

                {/* Metrics Badges */}
                {(newCount !== undefined || updatedCount !== undefined) && (
                    <div className="grid grid-cols-2 gap-3 pt-1">
                        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-2.5 text-center">
                            <span className="text-xs font-medium text-green-700 dark:text-green-400 block">Nuevos ECNs</span>
                            <span className="text-lg font-bold text-green-800 dark:text-green-300">{newCount || 0}</span>
                        </div>
                        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-2.5 text-center">
                            <span className="text-xs font-medium text-blue-700 dark:text-blue-400 block">Actualizados</span>
                            <span className="text-lg font-bold text-blue-800 dark:text-blue-300">{updatedCount || 0}</span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};