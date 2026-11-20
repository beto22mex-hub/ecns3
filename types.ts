

export enum ECNStatus {
  Pending = 'Pendiente',
  Implemented = 'Implementado',
  Canceled = 'Cancelado',
  PartialImplemented = 'Implementado Parcial',
}

export enum ActionStatus {
  Open = 'Open',
  Closed = 'Closed',
  NA = 'No Aplica',
  Evaluate = 'Evaluate',
  Act = 'Act',
  Finalize = 'Finalize',
  Check = 'Check',
  OK = 'OK',
}


export interface ComponentChange {
  id: string;
  assembly: string;
  assemblyRevision?: string;
  assemblyDescription?: string;
  oldComponent: string;
  newComponent: string;
  newComponentRevision?: string;
  newComponentDescription?: string;
  oldSubassembly?: string;
  newSubassembly?: string;
  newSubassemblyRevision?: string;
  newSubassemblyDescription?: string;
  sku?: string;
  family?: string;
  demand: number;
  onHandInventory: number;
  openPoQty: number;
  startDate: string;
  site: string;
}

export interface ECNNote {
  id: string;
  author: string;
  text: string;
  date: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  user: string;
  action: string;
}

// Fix: Added missing AuditLog type
export interface AuditLog {
    id: string | number;
    timestamp: string;
    target: string;
    type: 'Importación' | 'Modificación';
    user: string;
    details: string;
}

export interface ImportLogEntry {
  id: string;
  timestamp: string;
  fileName: string;
  details?: string[]; // The new detailed log messages
  // Keep old fields for backward compatibility
  totalRecords?: number;
  newEcns?: string[];
  updatedEcns?: string[];
  descriptionsUpdated?: number;
  skuByAssemblyUpdated?: number;
  newUsers?: number;
  updatedUsers?: number;
}

export interface ChecklistItem {
    id: string;
    question: string;
    department: string;
    actionStatus: ActionStatus | '';
    comment: string;
    who: string;
    when: string;
    crb: string;
    crbOk: string;
    cib: string;
    cibOk: string;
    iscImpl: string;
    implOk: string;
}

export interface ChecklistSection {
    name: string;
    items: ChecklistItem[];
}

export interface ECN {
  id: string; // e.g., 2020-5727
  initiator: string; // e.g., E650432
  description: string;
  status: ECNStatus;
  creationDate: string;
  implementationDate: string;
  daysRemaining: number;
  summary?: string;
  changes: ComponentChange[];
  notes: ECNNote[];
  auditLog: AuditLogEntry[];
  checklist: ChecklistItem[];
  // Aggregated fields for Grid View (SQL generated)
  skuList?: string;
  oldComponentList?: string;
  newComponentList?: string;
  familyList?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  department: string;
  photo?: string;
  jobTitle?: string;
  tenantId?: string;
  azureId?: string;
  hid?: string;
  role?: 'admin' | 'viewer';
  isSuperAdmin?: boolean;
  accessLevel?: string;
}

export interface AzureAuthConfig {
  clientId: string;
  tenantId: string;
  objectId?: string;
  redirectUri: string;
  isConfigured: boolean;
  hasSecret: boolean;
  appName: string;
  grantType?: 'authorization_code' | 'client_credentials' | 'both';
  serverToServerEnabled?: boolean;
  authEnabled?: boolean;
}

export interface AzureUserProfile {
  id: string;
  displayName: string;
  mail?: string;
  userPrincipalName?: string;
  mailNickname?: string; // Alias in Microsoft Graph / Exchange
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
  mobilePhone?: string;
  accountEnabled?: boolean;
  photo?: string;
  roles?: string[];
  hid?: string;
  isSuperAdmin?: boolean;
  role?: 'admin' | 'viewer';
}

export interface GraphUserLookupResult {
  success: boolean;
  found: boolean;
  query: string;
  source: 'microsoft_graph' | 'directory_fallback';
  user?: AzureUserProfile;
  usersList?: AzureUserProfile[];
  message: string;
  graphStatus?: number;
  permissionsNote?: string;
  error?: string;
}

export interface ServerAuthTestResult {
  success: boolean;
  message: string;
  tokenType?: string;
  expiresIn?: number;
  expiresAt?: string;
  roles?: string[];
  appId?: string;
  tenantId?: string;
  issuer?: string;
  rawClaims?: Record<string, any>;
  graphTest?: {
    success: boolean;
    endpoint: string;
    status: number;
    data?: any;
    error?: string;
  };
  error?: string;
  errorDescription?: string;
}


export interface BOMECNInfo {
    id: string;
    implementationDate: string;
    status: ECNStatus;
    description: string;
}

export interface BOMComponent {
  componentId: string;
  description: string;
  ecns: BOMECNInfo[];
}

export interface Assembly {
  id: string; // The assembly part number
  description: string;
  bom: BOMComponent[];
}

export interface MaterialItem {
  changeId: string;
  ecnId: string;
  partNumber: string;
  oldComponent: string;
  newComponent: string;
  assembly: string;
  site: string;
  family: string;
  demand: number;
  implementationDate: string;
  ecnStatus: string;
  ecnDescription: string;
  ecnInitiator: string;
}

export interface ImplementationTask {
    id: string;
    ecnId: string;
    family: string;
    department: string;
    taskName: string;
    assignedUserId: string;
    assignedUserName?: string;
    status: 'Pendiente' | 'En Proceso' | 'Completado' | 'Cancelado';
    dueDate: string;
    comments: string;
    updatedAt: string;
}