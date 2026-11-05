import type { Prisma } from "@prisma/client";
import type { StaticSmartRuntimeContract } from "./catalog-contract.js";
import { HostingError } from "../hosted/access.js";
import { isFhirReleaseEnabled } from "../hapi/partition_client.js";

export async function manageSandbox(
  tx: Prisma.TransactionClient,
  userId: string,
  slug: string,
  contract?: StaticSmartRuntimeContract,
) {
  const sandbox = await tx.sandbox.findFirst({
    where: {
      OR: [
        {
          id: /^[a-f0-9-]{36}$/i.test(slug)
            ? slug
            : "00000000-0000-0000-0000-000000000000",
        },
        { sandboxId: slug },
      ],
    },
    include: { collaborators: true },
  });
  if (
    !sandbox ||
    !(
      sandbox.createdByUserId === userId ||
      sandbox.collaborators.some(
        (c) => c.userId === userId && ["MANAGE", "OWNER"].includes(c.role),
      )
    )
  )
    throw new HostingError(403, "Select a sandbox you currently manage.");
  if (
    !isFhirReleaseEnabled(sandbox.fhirVersion) ||
    (contract && !contract.fhir_versions.includes(sandbox.fhirVersion as "R4"))
  )
    throw new HostingError(
      409,
      "The sandbox FHIR release is not supported by this application.",
    );
  return sandbox;
}

/** Recheck sandbox authority when a queued deployment becomes public. */
export async function assertDeploymentSandboxes(
  tx: Prisma.TransactionClient,
  applicationId: string,
  userId: string,
  contract?: StaticSmartRuntimeContract,
): Promise<void> {
  const bindings = await tx.hostedSandbox.findMany({
    where: { applicationId },
    include: { sandbox: true },
  });
  for (const binding of bindings)
    await manageSandbox(tx, userId, binding.sandbox.sandboxId, contract);
}
