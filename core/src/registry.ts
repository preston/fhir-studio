// Author: Preston Lee

export interface FhirPackageCatalogEntry {
  name: string;
  title?: string;
  description?: string;
  category?: 'US_CORE' | 'SMART' | 'CLINICAL' | 'FINANCIAL' | 'DAVINCI' | 'INTERNATIONAL';
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, FhirNpmPackageVersionInfo>;
  fhirVersion?: string[];
  url?: string;
  recommendedForCreation?: boolean;
}

export interface FhirNpmPackageVersionInfo {
  name: string;
  version: string;
  description?: string;
  fhirVersion?: string;
  dist?: {
    shasum?: string;
    tarball?: string;
  };
}

export interface FhirNpmPackageManifest {
  name: string;
  description?: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, FhirNpmPackageVersionInfo>;
}

export interface FhirPackageJson {
  name: string;
  version: string;
  description?: string;
  fhirVersions?: string[];
  dependencies?: Record<string, string>;
  author?: string;
  canonical?: string;
}

export interface RegistryImportResult {
  packageName: string;
  packageVersion: string;
  totalResources: number;
  importedResources: number;
  failedResources: number;
  errors: string[];
}

export const NOTABLE_FHIR_IGS: readonly FhirPackageCatalogEntry[] = [
  {
    name: 'hl7.fhir.us.core',
    title: 'US Core Implementation Guide v7.0.0',
    description: 'US Core Implementation Guide for USCDI v3/v4 & ONC HTI-1 requirements',
    category: 'US_CORE',
    fhirVersion: ['4.0.1'],
    recommendedForCreation: true,
    'dist-tags': { latest: '7.0.0' },
    versions: {
      '7.0.0': {
        name: 'hl7.fhir.us.core',
        version: '7.0.0',
        description: 'US Core IG v7.0.0 (USCDI v3/v4)',
        fhirVersion: '4.0.1'
      },
      '6.1.0': {
        name: 'hl7.fhir.us.core',
        version: '6.1.0',
        description: 'US Core IG v6.1.0 (USCDI v3)',
        fhirVersion: '4.0.1'
      },
      '8.0.0': {
        name: 'hl7.fhir.us.core',
        version: '8.0.0',
        description: 'US Core IG v8.0.0',
        fhirVersion: '4.0.1'
      }
    }
  },
  {
    name: 'hl7.fhir.uv.smart-app-launch',
    title: 'SMART App Launch Implementation Guide v2.2.0',
    description: 'SMART App Launch Framework v2.2.0 specification for OAuth2 and FHIR authorization',
    category: 'SMART',
    fhirVersion: ['4.0.1', '4.3.0', '5.0.0'],
    recommendedForCreation: true,
    'dist-tags': { latest: '2.2.0' },
    versions: {
      '2.2.0': {
        name: 'hl7.fhir.uv.smart-app-launch',
        version: '2.2.0',
        description: 'SMART App Launch v2.2.0',
        fhirVersion: '4.0.1'
      }
    }
  },
  {
    name: 'hl7.fhir.us.mcode',
    title: 'mCODE: Minimal Common Oncology Data Elements v3.0.0',
    description: 'mCODE Standard for cancer patient records and clinical oncological data',
    category: 'CLINICAL',
    fhirVersion: ['4.0.1'],
    recommendedForCreation: false,
    'dist-tags': { latest: '3.0.0' },
    versions: {
      '3.0.0': {
        name: 'hl7.fhir.us.mcode',
        version: '3.0.0',
        description: 'mCODE v3.0.0',
        fhirVersion: '4.0.1'
      }
    }
  },
  {
    name: 'hl7.fhir.us.carin-bb',
    title: 'CARIN Consumer Directed Payer Data Exchange (CARIN Blue Button)',
    description: 'CARIN for Blue Button IG for claims, EOBs, and coverage data exchange',
    category: 'FINANCIAL',
    fhirVersion: ['4.0.1'],
    recommendedForCreation: false,
    'dist-tags': { latest: '2.0.0' },
    versions: {
      '2.0.0': {
        name: 'hl7.fhir.us.carin-bb',
        version: '2.0.0',
        description: 'CARIN BB v2.0.0',
        fhirVersion: '4.0.1'
      }
    }
  },
  {
    name: 'hl7.fhir.us.davinci-crd',
    title: 'Da Vinci Coverage Requirements Discovery (CRD)',
    description: 'CDS Hooks and FHIR-based real-time coverage and documentation requirements',
    category: 'DAVINCI',
    fhirVersion: ['4.0.1'],
    recommendedForCreation: false,
    'dist-tags': { latest: '2.0.1' },
    versions: {
      '2.0.1': {
        name: 'hl7.fhir.us.davinci-crd',
        version: '2.0.1',
        description: 'Da Vinci CRD v2.0.1',
        fhirVersion: '4.0.1'
      }
    }
  },
  {
    name: 'hl7.fhir.us.davinci-dtr',
    title: 'Da Vinci Documentation Templates and Rules (DTR)',
    description: 'Questionnaires and CQL execution for payer prior authorization documentation',
    category: 'DAVINCI',
    fhirVersion: ['4.0.1'],
    recommendedForCreation: false,
    'dist-tags': { latest: '2.0.0' },
    versions: {
      '2.0.0': {
        name: 'hl7.fhir.us.davinci-dtr',
        version: '2.0.0',
        description: 'Da Vinci DTR v2.0.0',
        fhirVersion: '4.0.1'
      }
    }
  }
] as const;

