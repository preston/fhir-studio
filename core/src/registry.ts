// Author: Preston Lee

export interface FhirPackageCatalogEntry {
  name: string;
  title?: string;
  description?: string;
  category?: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, FhirNpmPackageVersionInfo>;
  fhirVersion?: string[];
  url?: string;
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

export interface ImplementationGuideSummary {
  id: string;
  packageId: string;
  version: string;
  title: string;
  description: string | null;
  fhirVersion: string;
  category: string;
  canonicalUrl: string | null;
  url: string | null;
  isSuggested: boolean;
  author: string | null;
  dependencies: Record<string, string>;
  tarballUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateImplementationGuidePayload {
  packageId: string;
  version: string;
  title: string;
  description?: string | null;
  fhirVersion?: string;
  category?: string;
  canonicalUrl?: string | null;
  url?: string | null;
  isSuggested?: boolean;
  author?: string | null;
  dependencies?: Record<string, string>;
  tarballUrl?: string | null;
}

export interface UpdateImplementationGuidePayload {
  packageId?: string;
  version?: string;
  title?: string;
  description?: string | null;
  fhirVersion?: string;
  category?: string;
  canonicalUrl?: string | null;
  url?: string | null;
  isSuggested?: boolean;
  author?: string | null;
  dependencies?: Record<string, string>;
  tarballUrl?: string | null;
}

export interface ImplementationGuideFilter {
  search?: string;
  fhirVersion?: string;
  category?: string;
  isSuggested?: boolean;
}
