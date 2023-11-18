import type { Prisma } from "@prisma/client";

import { getMetadataHelpers } from "@calcom/lib/getMetadataHelpers";
import { prisma } from "@calcom/prisma";
import { teamMetadataSchema } from "@calcom/prisma/zod-utils";

import type { TrpcSessionUser } from "../../../trpc";
import type { TAdminUpdate } from "./adminUpdate.schema";

type AdminUpdateOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TAdminUpdate;
};

export const adminUpdateHandler = async ({ input }: AdminUpdateOptions) => {
  const { id, ...restInput } = input;
  const existingOrg = await prisma.team.findUnique({
    where: {
      id: id,
    },
  });

  if (!existingOrg) {
    throw new Error("Organization not found");
  }

  const { mergeMetadata } = getMetadataHelpers(teamMetadataSchema.unwrap(), existingOrg.metadata);
  const data: Prisma.TeamUpdateArgs["data"] = {
    ...restInput,
    metadata: mergeMetadata({ ...restInput.metadata }),
  };

  if (restInput.slug) {
    await throwIfSlugConflicts({ id, slug: restInput.slug });
    data.slug = input.slug;
    data.metadata = mergeMetadata({
      // If we save slug, we don't need the requestedSlug anymore
      requestedSlug: undefined,
      ...input.metadata,
    });
  }

  const updatedOrganisation = await prisma.team.update({
    where: { id },
    data,
  });

  return updatedOrganisation;
};

export default adminUpdateHandler;

async function throwIfSlugConflicts({ id, slug }: { id: number; slug: string }) {
  const organizationsWithSameSlug = await prisma.team.findMany({
    where: {
      slug: slug,
      parentId: null,
    },
  });

  if (organizationsWithSameSlug.length > 1) {
    throw new Error("There can only be one organization with a given slug");
  }

  const foundOrg = organizationsWithSameSlug[0];
  if (!foundOrg) {
    return;
  }

  // If foundOrg isn't same as the org being edited
  if (foundOrg.id !== id) {
    throw new Error("Organization with same slug already exists");
  }
}
