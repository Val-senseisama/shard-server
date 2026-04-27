import { Types } from "mongoose";
import {
  catchError,
  logError,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import Team from "../../models/Team.js";
import Chat from "../../models/Chat.js";
import { User } from "../../models/User.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function populateTeam(team: any) {
  const userIds = [...new Set([team.owner.toString(), ...team.members.map((m: any) => m.toString())])];
  const [, users] = await catchError(
    User.find({ _id: { $in: userIds } }).select("username profilePic").lean()
  );
  const userMap = new Map((users || []).map((u: any) => [u._id.toString(), u]));

  const toMember = (id: any) => {
    const u = userMap.get(id.toString());
    return { id: id.toString(), username: u?.username ?? "Unknown", profilePic: u?.profilePic ?? null };
  };

  return {
    id: team._id.toString(),
    name: team.name,
    owner: toMember(team.owner),
    members: team.members.map(toMember),
    memberCount: team.members.length,
    chatId: team.chatId?.toString() ?? null,
    createdAt: team.createdAt instanceof Date
      ? team.createdAt.toISOString()
      : new Date(team.createdAt).toISOString(),
  };
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

export default {
  Mutation: {
    async createTeam(_, { name, memberIds }: { name: string; memberIds: string[] }, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const trimmedName = name?.trim();
      if (!trimmedName || trimmedName.length < 2) {
        return { success: false, message: "Team name must be at least 2 characters." };
      }

      // Deduplicate and ensure owner is always a member
      const uniqueMembers = [...new Set([context.id, ...memberIds])].map(
        (id) => new Types.ObjectId(id)
      );

      const [createErr, team] = await catchError(
        Team.create({
          name: trimmedName,
          owner: new Types.ObjectId(context.id),
          members: uniqueMembers,
        })
      );

      if (createErr || !team) {
        logError("createTeam", createErr);
        return { success: false, message: "Failed to create team." };
      }

      // Create the team group chat
      const [chatErr, chat] = await catchError(
        Chat.create({
          type: "group",
          name: trimmedName,
          participants: uniqueMembers,
        })
      );

      if (!chatErr && chat) {
        await Team.findByIdAndUpdate(team._id, { chatId: chat._id });
        team.chatId = chat._id;
      }

      SaveAuditTrail({
        userId: context.id,
        task: "Created Team",
        details: `Created team "${trimmedName}" with ${uniqueMembers.length} members`,
      });

      return { success: true, message: "Team created.", team: await populateTeam(team) };
    },

    async updateTeam(
      _,
      { teamId, name, addMemberIds, removeMemberIds }:
        { teamId: string; name?: string; addMemberIds?: string[]; removeMemberIds?: string[] },
      context: any
    ) {
      if (!context.id) ThrowError("Please login to continue.");

      const [findErr, team] = await catchError(Team.findById(teamId).lean());
      if (findErr || !team) return { success: false, message: "Team not found." };
      if (team.owner.toString() !== context.id) {
        return { success: false, message: "Only the team owner can update the team." };
      }

      const update: any = {};
      if (name?.trim()) update.name = name.trim();

      let members = team.members.map((m: any) => m.toString());

      if (addMemberIds?.length) {
        for (const id of addMemberIds) {
          if (!members.includes(id)) members.push(id);
        }
      }
      if (removeMemberIds?.length) {
        // Owner cannot be removed
        members = members.filter(
          (m) => !removeMemberIds.includes(m) || m === context.id
        );
      }

      update.members = members.map((m: string) => new Types.ObjectId(m));

      const [updateErr, updated] = await catchError(
        Team.findByIdAndUpdate(teamId, update, { new: true }).lean()
      );
      if (updateErr || !updated) return { success: false, message: "Failed to update team." };

      // Sync chat participants
      if (updated.chatId) {
        await catchError(
          Chat.findByIdAndUpdate(updated.chatId, {
            $set: { participants: update.members },
          })
        );
        if (update.name) {
          await catchError(Chat.findByIdAndUpdate(updated.chatId, { name: update.name }));
        }
      }

      SaveAuditTrail({ userId: context.id, task: "Updated Team", details: `Updated team ${teamId}` });
      return { success: true, message: "Team updated.", team: await populateTeam(updated) };
    },

    async deleteTeam(_, { teamId }: { teamId: string }, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const [findErr, team] = await catchError(Team.findById(teamId).lean());
      if (findErr || !team) return { success: false, message: "Team not found." };
      if (team.owner.toString() !== context.id) {
        return { success: false, message: "Only the team owner can delete the team." };
      }

      if (team.chatId) {
        await catchError(Chat.findByIdAndDelete(team.chatId));
      }
      await catchError(Team.findByIdAndDelete(teamId));

      SaveAuditTrail({ userId: context.id, task: "Deleted Team", details: `Deleted team ${teamId}` });
      return { success: true, message: "Team deleted." };
    },

    async leaveTeam(_, { teamId }: { teamId: string }, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const [findErr, team] = await catchError(Team.findById(teamId).lean());
      if (findErr || !team) return { success: false, message: "Team not found." };
      if (team.owner.toString() === context.id) {
        return { success: false, message: "You own this team. Transfer ownership or delete it." };
      }

      const isMember = team.members.some((m: any) => m.toString() === context.id);
      if (!isMember) return { success: false, message: "You are not a member of this team." };

      await catchError(
        Team.findByIdAndUpdate(teamId, {
          $pull: { members: new Types.ObjectId(context.id) },
        })
      );

      if (team.chatId) {
        await catchError(
          Chat.findByIdAndUpdate(team.chatId, {
            $pull: { participants: new Types.ObjectId(context.id) },
          })
        );
      }

      return { success: true, message: "You have left the team." };
    },
  },

  Query: {
    async myTeams(_, __, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const userId = new Types.ObjectId(context.id);
      const [err, teams] = await catchError(
        Team.find({ members: userId }).sort({ updatedAt: -1 }).lean()
      );

      if (err) {
        logError("myTeams", err);
        return { success: false, teams: [] };
      }

      const populated = await Promise.all((teams || []).map(populateTeam));
      return { success: true, teams: populated };
    },

    async getTeam(_, { teamId }: { teamId: string }, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const [err, team] = await catchError(Team.findById(teamId).lean());
      if (err || !team) return { success: false, message: "Team not found.", team: null };

      const isMember = team.members.some((m: any) => m.toString() === context.id);
      if (!isMember) return { success: false, message: "Access denied.", team: null };

      return { success: true, team: await populateTeam(team) };
    },
  },
};
