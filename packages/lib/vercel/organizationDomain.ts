import { subdomainSuffix } from "@calcom/ee/organizations/lib/orgDomains";
import { HttpError } from "@calcom/lib/http-error";
import { safeStringify } from "@calcom/lib/safeStringify";

import logger from "../logger";

const apiForProjectUrl = `https://api.vercel.com/v9/projects/${process.env.PROJECT_ID_VERCEL}`;

export const deleteDomain = async (slug: string) => {
  const fullDomain = `${slug}.${subdomainSuffix()}`;
  const response = await fetch(
    `${apiForProjectUrl}/domains/${fullDomain}?teamId=${process.env.TEAM_ID_VERCEL}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.AUTH_BEARER_TOKEN_VERCEL}`,
      },
      method: "DELETE",
    }
  );

  const data = await response.json();
  if (!data.error) {
    return true;
  }

  if (data.error.code === "not_found") {
    // Domain is already deleted
    return true;
  }

  handleVercelDomainError(data);
  return false;
};

export const createDomain = async (slug: string) => {
  const response = await fetch(`${apiForProjectUrl}/domains?teamId=${process.env.TEAM_ID_VERCEL}`, {
    body: JSON.stringify({ name: `${slug}.${subdomainSuffix()}` }),
    headers: {
      Authorization: `Bearer ${process.env.AUTH_BEARER_TOKEN_VERCEL}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const data = await response.json();

  if (!data.error) {
    return true;
  }

  // TODO: What if the domain already is created ?

  handleVercelDomainError(data);
  return false;
};

export const renameDomain = async (oldSlug: string, newSlug: string) => {
  // First create new domain and if it fails we still have the old domain
  await createDomain(newSlug);
  await deleteDomain(oldSlug);
};

function handleVercelDomainError(error: { code: string; domain: string }) {
  const log = logger.getSubLogger({ prefix: ["vercelCreateDomain"] });

  // Domain is already owned by another team but you can request delegation to access it
  if (error.code === "forbidden") {
    const errorMessage = "Domain is already owned by another team";
    log.error(
      safeStringify({
        errorMessage,
        vercelError: error,
      })
    );
    throw new HttpError({
      message: errorMessage,
      statusCode: 400,
    });
  }

  if (error.code === "domain_taken") {
    const errorMessage = "Domain is already being used by a different project";
    log.error(
      safeStringify({
        errorMessage,
        vercelError: error,
      })
    );
    throw new HttpError({
      message: errorMessage,
      statusCode: 400,
    });
  }

  const errorMessage = `Failed to take action for domain: ${error.domain}`;
  log.error(safeStringify({ errorMessage, vercelError: error }));
  throw new HttpError({
    message: errorMessage,
    statusCode: 400,
  });
}
