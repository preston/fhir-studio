// Author: Preston Lee

import 'dotenv/config';
import { AppointmentEntityType } from '@prisma/client';
import { getPrisma, disconnectPrisma } from './prisma.js';
import {
  DEFAULT_ROLE_NAME,
  ADMINISTRATOR_ROLE_NAME,
  ADMINISTRATORS_GROUP_NAME,
  USERS_GROUP_NAME,
} from '../authorization/iam.js';

export async function seed(): Promise<void> {
  const prisma = getPrisma();

  console.log('Seeding FHIR Studio database...');

  // 1. Roles
  const adminRole = await prisma.role.upsert({
    where: { name: ADMINISTRATOR_ROLE_NAME },
    create: {
      name: ADMINISTRATOR_ROLE_NAME,
      description: 'System administrator with full system management and reporting access',
      default: false,
      ssoRoleMapping: 'fhir-studio-admin',
      permission_sandboxes_create: true,
      permission_sandboxes_shared: true,
      permission_ehr_simulator: true,
      permission_data_manager: true,
      permission_applications_register: true,
      permission_package_import: true,
      permission_global_manage: true,
    },
    update: {
      ssoRoleMapping: 'fhir-studio-admin',
      permission_sandboxes_create: true,
      permission_sandboxes_shared: true,
      permission_ehr_simulator: true,
      permission_data_manager: true,
      permission_applications_register: true,
      permission_package_import: true,
      permission_global_manage: true,
    },
  });

  const userRole = await prisma.role.upsert({
    where: { name: DEFAULT_ROLE_NAME },
    create: {
      name: DEFAULT_ROLE_NAME,
      description: 'Standard developer role with sandbox, application, EHR simulator, and data manager access',
      default: true,
      ssoRoleMapping: 'fhir-studio-user',
      permission_sandboxes_create: true,
      permission_sandboxes_shared: true,
      permission_ehr_simulator: true,
      permission_data_manager: true,
      permission_applications_register: true,
      permission_package_import: true,
      permission_global_manage: false,
    },
    update: {
      default: true,
      ssoRoleMapping: 'fhir-studio-user',
      permission_sandboxes_create: true,
      permission_sandboxes_shared: true,
      permission_ehr_simulator: true,
      permission_data_manager: true,
      permission_applications_register: true,
      permission_package_import: true,
      permission_global_manage: false,
    },
  });

  // 2. Groups
  const adminGroup = await prisma.group.upsert({
    where: { name: ADMINISTRATORS_GROUP_NAME },
    create: {
      name: ADMINISTRATORS_GROUP_NAME,
      description: 'System administrators group',
      ssoRoleMapping: 'fhir-studio-admin',
    },
    update: {
      ssoRoleMapping: 'fhir-studio-admin',
    },
  });

  const usersGroup = await prisma.group.upsert({
    where: { name: USERS_GROUP_NAME },
    create: {
      name: USERS_GROUP_NAME,
      description: 'Standard FHIR Studio users group',
      ssoRoleMapping: 'fhir-studio-user',
    },
    update: {
      ssoRoleMapping: 'fhir-studio-user',
    },
  });

  // 3. Appointments on Groups
  await prisma.appointment.upsert({
    where: {
      entityType_entityId_roleId: {
        entityType: AppointmentEntityType.Group,
        entityId: adminGroup.id,
        roleId: adminRole.id,
      },
    },
    create: {
      entityType: AppointmentEntityType.Group,
      entityId: adminGroup.id,
      roleId: adminRole.id,
    },
    update: {},
  });

  await prisma.appointment.upsert({
    where: {
      entityType_entityId_roleId: {
        entityType: AppointmentEntityType.Group,
        entityId: usersGroup.id,
        roleId: userRole.id,
      },
    },
    create: {
      entityType: AppointmentEntityType.Group,
      entityId: usersGroup.id,
      roleId: userRole.id,
    },
    update: {},
  });

  // 4. Sample Public SMART Applications (FHIR R4 & SMART on FHIR v2 compatible)
  const sampleApplications = [
    {
      clientId: 'example-application',
      clientName: 'Example Application',
      launchUri: '/example-application/launch',
      redirectUris: ['/example-application', '/example-application/launch'],
      briefDescription: 'Built-in reference SMART on FHIR v2 application with PKCE S256, condition, medication, lab, and encounter viewer.',
      author: 'Logica Health / FHIR Studio',
      isCustom: false,
      isSample: true,
      scope: 'openid profile email patient/*.read patient/*.rs launch launch/patient fhirUser',
    },
  ];

  for (const application of sampleApplications) {
    await prisma.application.upsert({
      where: { clientId: application.clientId },

      create: {
        ...application,
      },
      update: {
        clientName: application.clientName,
        launchUri: application.launchUri,
        redirectUris: application.redirectUris,
        briefDescription: application.briefDescription,
        author: application.author,
        scope: application.scope,
        isSample: true,
        isCustom: false,
      },
    });
  }

  // 5. Baseline Implementation Guides (FHIR Package Registry Catalog)
  const baselineImplementationGuides = [
    {
      packageId: 'hl7.fhir.us.core',
      version: '7.0.0',
      title: 'US Core Implementation Guide v7.0.0 (Latest Final)',
      description: 'ONC HTI-1 & USCDI v3/v4 compliance profiles for US Realm healthcare data exchange.',
      fhirVersion: '4.0.1',
      category: 'US_CORE',
      canonicalUrl: 'http://hl7.org/fhir/us/core',
      author: 'HL7 International / US Realm',
      isSuggested: true,
    },
    {
      packageId: 'hl7.fhir.us.core',
      version: '6.1.0',
      title: 'US Core Implementation Guide v6.1.0',
      description: 'USCDI v3 compliant profiles and synthetic data definitions.',
      fhirVersion: '4.0.1',
      category: 'US_CORE',
      canonicalUrl: 'http://hl7.org/fhir/us/core',
      author: 'HL7 International / US Realm',
      isSuggested: true,
    },
    {
      packageId: 'hl7.fhir.us.core',
      version: '8.0.0',
      title: 'US Core Implementation Guide v8.0.0',
      description: 'USCDI v4/v5 advanced profiles for patient access and clinical exchange.',
      fhirVersion: '4.0.1',
      category: 'US_CORE',
      canonicalUrl: 'http://hl7.org/fhir/us/core',
      author: 'HL7 International / US Realm',
      isSuggested: true,
    },
    {
      packageId: 'hl7.fhir.uv.smart-app-launch',
      version: '2.2.0',
      title: 'SMART App Launch Framework v2.2.0',
      description: 'SMART on FHIR v2 authentication, OAuth2, and granular scopes authorization profiles.',
      fhirVersion: '4.0.1',
      category: 'SMART',
      canonicalUrl: 'http://hl7.org/fhir/smart-app-launch',
      author: 'HL7 International / FHIR Infrastructure',
      isSuggested: true,
    },
    {
      packageId: 'hl7.fhir.us.mcode',
      version: '3.0.0',
      title: 'mCODE: Minimal Common Oncology Data Elements v3.0.0',
      description: 'Standardized oncology clinical data models and cancer patient record definitions.',
      fhirVersion: '4.0.1',
      category: 'CLINICAL',
      canonicalUrl: 'http://hl7.org/fhir/us/mcode',
      author: 'HL7 International / Clinical Interoperability Council',
      isSuggested: true,
    },
    {
      packageId: 'hl7.fhir.us.carin-bb',
      version: '2.0.0',
      title: 'CARIN Consumer Directed Payer Data Exchange (Blue Button) v2.0.0',
      description: 'Consumer directed payer & claim data exchange, EOBs, and coverage definitions.',
      fhirVersion: '4.0.1',
      category: 'FINANCIAL',
      canonicalUrl: 'http://hl7.org/fhir/us/carin-bb',
      author: 'CARIN Alliance / HL7 Financial Management',
      isSuggested: true,
    },
    {
      packageId: 'hl7.fhir.us.davinci-crd',
      version: '2.0.1',
      title: 'Da Vinci Coverage Requirements Discovery (CRD) v2.0.1',
      description: 'CDS Hooks and FHIR-based real-time coverage and documentation requirements.',
      fhirVersion: '4.0.1',
      category: 'DAVINCI',
      canonicalUrl: 'http://hl7.org/fhir/us/davinci-crd',
      author: 'Da Vinci Project / HL7 Clinical Decision Support',
      isSuggested: true,
    },
    {
      packageId: 'hl7.fhir.us.davinci-dtr',
      version: '2.0.0',
      title: 'Da Vinci Documentation Templates and Rules (DTR) v2.0.0',
      description: 'Questionnaires and CQL execution for payer prior authorization documentation.',
      fhirVersion: '4.0.1',
      category: 'DAVINCI',
      canonicalUrl: 'http://hl7.org/fhir/us/davinci-dtr',
      author: 'Da Vinci Project / HL7 Clinical Decision Support',
      isSuggested: true,
    },
    {
      packageId: 'hl7.fhir.us.qicore',
      version: '5.0.0',
      title: 'QI-Core Implementation Guide v5.0.0',
      description: 'Quality Improvement Core framework for electronic clinical quality measures.',
      fhirVersion: '4.0.1',
      category: 'CLINICAL',
      canonicalUrl: 'http://hl7.org/fhir/us/qicore',
      author: 'HL7 International / Clinical Quality Information',
      isSuggested: true,
    },
  ];

  for (const ig of baselineImplementationGuides) {
    await prisma.implementationGuide.upsert({
      where: {
        packageId_version: {
          packageId: ig.packageId,
          version: ig.version,
        },
      },
      create: {
        ...ig,
      },
      update: {
        title: ig.title,
        description: ig.description,
        fhirVersion: ig.fhirVersion,
        category: ig.category,
        canonicalUrl: ig.canonicalUrl,
        author: ig.author,
        isSuggested: ig.isSuggested,
      },
    });
  }

  console.log('Seeding completed successfully.');
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  seed()
    .catch((err) => {
      console.error('Seeding failed:', err);
      process.exit(1);
    })
    .finally(async () => {
      await disconnectPrisma();
    });
}
