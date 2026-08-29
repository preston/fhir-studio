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

  // 4. Sample Public SMART Applications
  const sampleApplications = [
    {
      clientId: 'example-application',
      clientName: 'Example Application',
      launchUri: '/example-application/launch',
      redirectUris: ['/example-application', '/example-application/launch'],
      briefDescription: 'Built-in reference SMART on FHIR v2 application with PKCE S256 and clinical viewer.',
      author: 'Logica Health / FHIR Studio',
      isCustom: false,
      isSample: true,
      scope: 'openid profile email patient/*.read patient/*.rs launch launch/patient fhirUser',
    },
    {
      clientId: 'growth-chart-application',
      clientName: 'Growth Chart',
      launchUri: 'https://growth-chart.smarthealthit.org/launch.html',
      redirectUris: ['https://growth-chart.smarthealthit.org/'],
      briefDescription: 'Interactive pediatric growth curves application (CDC/WHO).',
      author: 'SMART Health IT',
      isCustom: false,
      isSample: true,
      scope: 'launch/patient patient/*.read openid profile',
    },
    {
      clientId: 'bilirubin-risk-chart',
      clientName: 'Bilirubin Risk Chart',
      launchUri: 'https://bilirubin.smarthealthit.org/launch.html',
      redirectUris: ['https://bilirubin.smarthealthit.org/'],
      briefDescription: 'Newborn bilirubin hour-specific risk assessment tool (Bhutani nomogram).',
      author: 'Intermountain Healthcare / SMART',
      isCustom: false,
      isSample: true,
      scope: 'launch/patient patient/*.read openid profile',
    },
    {
      clientId: 'cardiac-risk-application',
      clientName: 'Cardiac Risk Assessment',
      launchUri: 'https://cardiac-risk.smarthealthit.org/launch.html',
      redirectUris: ['https://cardiac-risk.smarthealthit.org/'],
      briefDescription: 'Framingham and ACC/AHA ASCVD 10-year risk estimator.',
      author: 'Boston Children’s Hospital',
      isCustom: false,
      isSample: true,
      scope: 'launch/patient patient/*.read openid profile',
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
        isSample: true,
        isCustom: false,
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
