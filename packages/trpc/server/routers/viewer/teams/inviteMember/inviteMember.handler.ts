import { updateQuantitySubscriptionFromStripe } from "@calcom/features/ee/teams/lib/payments";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import { IS_TEAM_BILLING_ENABLED } from "@calcom/lib/constants";
import { getTranslation } from "@calcom/lib/server/i18n";
import { prisma } from "@calcom/prisma";
import type { TrpcSessionUser } from "@calcom/trpc/server/trpc";

import type { TInviteMemberInputSchema } from "./inviteMember.schema";
import {
  checkPermissions,
  getTeamOrThrow,
  getEmailsToInvite,
  getOrgConnectionInfo,
  getIsOrgVerified,
  sendVerificationEmail,
  getUsersToInviteOrThrowIfExists,
  createNewUsersConnectToOrgIfExists,
  createProvisionalMemberships,
  getUsersForMemberships,
  sendTeamInviteEmails,
} from "./utils";

type InviteMemberOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TInviteMemberInputSchema;
};

export const inviteMemberHandler = async ({ ctx, input }: InviteMemberOptions) => {
  const translation = await getTranslation(input.language ?? "en", "common");
  await checkRateLimitAndThrowError({
    identifier: `invitedBy:${ctx.user.id}`,
  });
  await checkPermissions({
    userId: ctx.user.id,
    teamId:
      ctx.user.organization.id && ctx.user.organization.isOrgAdmin ? ctx.user.organization.id : input.teamId,
    isOrg: input.isOrg,
  });

  const team = await getTeamOrThrow(input.teamId, input.isOrg);
  const { autoAcceptEmailDomain, orgVerified } = getIsOrgVerified(input.isOrg, team);
  const emailsToInvite = await getEmailsToInvite(input.usernameOrEmail);
  const orgConnectionInfoMap = emailsToInvite.reduce((acc, email) => {
    return {
      ...acc,
      [email]: getOrgConnectionInfo({
        orgVerified,
        orgAutoAcceptDomain: autoAcceptEmailDomain,
        usersEmail: email,
        team,
        isOrg: input.isOrg,
      }),
    };
  }, {} as Record<string, ReturnType<typeof getOrgConnectionInfo>>);
  const existingUsersWithMembersips = await getUsersToInviteOrThrowIfExists({
    usernameOrEmail: emailsToInvite,
    teamId: input.teamId,
    isOrg: input.isOrg,
  });
  const existingUsersEmails = existingUsersWithMembersips.map((user) => user.email);
  const newUsersEmails = emailsToInvite.filter((email) => !existingUsersEmails.includes(email));

  // deal with users to create and invite to team/org
  if (newUsersEmails.length) {
    await createNewUsersConnectToOrgIfExists({
      usernamesOrEmails: newUsersEmails,
      input,
      connectionInfoMap: orgConnectionInfoMap,
      autoAcceptEmailDomain,
      parentId: team.parentId,
    });
    for (let index = 0; index < newUsersEmails.length; index++) {
      const usernameOrEmail = newUsersEmails[index];
      await sendVerificationEmail({
        usernameOrEmail,
        team,
        translation,
        ctx,
        input,
        connectionInfo: orgConnectionInfoMap[usernameOrEmail],
      });
    }
  }

  // deal with existing users invited to join the team/org
  if (existingUsersWithMembersips.length) {
    const [usersToAutoJoin, regularUsers] = getUsersForMemberships({
      existingUsersWithMembersips,
      isOrg: input.isOrg,
      team,
    });

    // invited users can autojoin, create their memberships in org
    if (usersToAutoJoin.length) {
      await prisma.membership.createMany({
        data: usersToAutoJoin.map((userToAutoJoin) => ({
          userId: userToAutoJoin.id,
          teamId: team.id,
          accepted: true,
          role: input.role,
        })),
      });
    }

    // invited users cannot autojoin, create provisional memberships and send email
    if (regularUsers.length) {
      await createProvisionalMemberships({
        input,
        invitees: regularUsers,
      });
      await sendTeamInviteEmails({
        currentUserName: ctx?.user?.name,
        currentUserTeamName: team?.name,
        existingUsersWithMembersips: regularUsers,
        language: translation,
        isOrg: input.isOrg,
      });
    }
  }

  if (IS_TEAM_BILLING_ENABLED) {
    if (team.parentId) {
      await updateQuantitySubscriptionFromStripe(team.parentId);
    } else {
      await updateQuantitySubscriptionFromStripe(input.teamId);
    }
  }
  return input;
};
