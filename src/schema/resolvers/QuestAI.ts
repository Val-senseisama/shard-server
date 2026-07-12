import mongoose from "mongoose";
import { catchError, logError, ThrowError } from "../../Helpers/Helpers.js";
import Shard from "../../models/Shard.js";
import MiniGoal from "../../models/MiniGoal.js";
import { User } from "../../models/User.js";
import Chat, { Message } from "../../models/Chat.js";
import { tierOf, upgradeError } from "../../Helpers/Entitlements.js";
import { chatAboutShard } from "../../Helpers/AIHelper.js";
import { moderate } from "../../Helpers/ContentModerator.js";
import { cacheInvalidate } from "../../Helpers/Cache.js";
import ShardResolvers from "./Shard.js";

const ShardM: any = ShardResolvers.Mutation;

function hasShardAccess(shard: any, userId: string): boolean {
  const isOwner = shard.owner?.toString() === userId;
  const isParticipant = (shard.participants || []).some((p: any) => p.user?.toString() === userId);
  return isOwner || isParticipant;
}

// Map a Message doc to the GraphQL QuestAIMessage shape
function toQAIMessage(m: any) {
  return {
    id: m._id.toString(),
    role: m.type === "ai_reply" || m.type === "ai_proposal" ? "assistant" : "user",
    content: m.content,
    type: m.type,
    proposal: m.aiProposal
      ? {
          status: m.aiProposal.status,
          summary: m.aiProposal.summary || null,
          actions: (m.aiProposal.actions || []).map((a: any) => ({
            op: a.op,
            miniGoalId: a.miniGoalId ? a.miniGoalId.toString() : null,
            taskIndex: typeof a.taskIndex === "number" ? a.taskIndex : null,
            payload: a.payload || null,
          })),
        }
      : null,
    createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : null,
  };
}

function buildShardContext(shard: any, miniGoals: any[]): string {
  const lines: string[] = [
    `Title: ${shard.title}`,
    `Description: ${shard.description || "(none)"}`,
    `Progress: ${shard.progress?.completion ?? 0}%`,
  ];
  for (const mg of miniGoals) {
    lines.push(`\nMini-goal [id: ${mg._id}] "${mg.title}"${mg.completed ? " (completed)" : ""}`);
    (mg.tasks || [])
      .filter((t: any) => !t.deleted)
      .forEach((t: any, i: number) => lines.push(`  - task[${i}] ${t.title}${t.completed ? " ✓" : ""}`));
  }
  return lines.join("\n");
}

export default {
  Mutation: {
    async chatWithQuestAI(_: any, { shardId, message }: { shardId: string; message: string }, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const msgMod = moderate(message, "goal");
      if (!msgMod.allowed) {
        return { success: false, message: msgMod.crisisMessage || msgMod.reason || "Message not allowed.", messages: [] };
      }

      const [shardErr, shard] = await catchError(Shard.findById(shardId).lean());
      if (shardErr || !shard) return { success: false, message: "Quest not found." };
      if (!hasShardAccess(shard, context.id)) return { success: false, message: "You don't have access to this quest." };

      // Pro gate — AI Quest Coach is a Pro feature
      const [, user] = await catchError(User.findById(context.id, "subscriptionTier role trialEndsAt").lean());
      if (tierOf(user as any) !== "pro") {
        return upgradeError("AI Quest Coach is a Pro feature. Upgrade to chat with your coach and refine quests!");
      }

      // Get-or-create the private AI thread for (user, shard)
      let [, chat] = await catchError(Chat.findOne({ type: "ai", shardId, participants: context.id }));
      if (!chat) {
        const [createErr, created] = await catchError(
          Chat.create({ type: "ai", shardId, participants: [context.id], name: `AI Coach: ${(shard as any).title}` })
        );
        if (createErr || !created) return { success: false, message: "Failed to start AI chat." };
        chat = created;
      }

      const [, miniGoals] = await catchError(MiniGoal.find({ shardId }).sort({ createdAt: 1 }).lean());
      const shardContext = buildShardContext(shard, (miniGoals as any[]) || []);

      const [, recent] = await catchError(
        Message.find({ chatId: (chat as any)._id, type: { $in: ["text", "ai_reply"] }, deleted: false })
          .sort({ _id: -1 })
          .limit(10)
          .lean()
      );
      const history = ((recent as any[]) || [])
        .reverse()
        .map((m: any) => `${m.type === "ai_reply" ? "Coach" : "User"}: ${m.content}`)
        .join("\n");

      // Persist the user's message
      await Message.create({ chatId: (chat as any)._id, sender: context.id, content: message, type: "text", readBy: [context.id] });

      const result = await chatAboutShard(message, shardContext, history);

      // Persist the AI reply
      await Message.create({ chatId: (chat as any)._id, sender: context.id, content: result.reply, type: "ai_reply", readBy: [context.id] });

      // Persist a proposal card when the AI suggests changes
      let proposalMsg: any = null;
      if (result.proposal) {
        const actions = (result.proposal.actions || []).map((a: any) => ({
          op: a.op,
          miniGoalId: a.miniGoalId && mongoose.isValidObjectId(a.miniGoalId) ? a.miniGoalId : undefined,
          taskIndex: a.payload?.taskIndex,
          payload: a.payload || {},
        }));
        const [, created] = await catchError(
          Message.create({
            chatId: (chat as any)._id,
            sender: context.id,
            content: result.proposal.summary || "Suggested changes to your quest",
            type: "ai_proposal",
            readBy: [context.id],
            aiProposal: { status: "pending", summary: result.proposal.summary, actions },
          })
        );
        proposalMsg = created;
      }

      return {
        success: true,
        message: "OK",
        chatId: (chat as any)._id.toString(),
        reply: result.reply,
        proposal: proposalMsg ? toQAIMessage(proposalMsg) : null,
      };
    },

    async applyQuestAISuggestion(_: any, { messageId }: { messageId: string }, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const [msgErr, msg] = await catchError(Message.findById(messageId));
      if (msgErr || !msg || (msg as any).type !== "ai_proposal" || !(msg as any).aiProposal) {
        return { success: false, message: "Proposal not found.", applied: [] };
      }
      const proposal = (msg as any).aiProposal;
      if (proposal.status !== "pending") {
        return { success: true, message: `This proposal was already ${proposal.status}.`, applied: [] };
      }

      const [, chat] = await catchError(Chat.findById((msg as any).chatId).lean());
      const shardId = (chat as any)?.shardId?.toString();
      const [, shard] = await catchError(Shard.findById(shardId).lean());
      if (!shard) return { success: false, message: "Quest not found.", applied: [] };
      if ((shard as any).owner.toString() !== context.id) {
        return { success: false, message: "Only the quest owner can apply changes.", applied: [] };
      }

      const applied: string[] = [];
      for (const a of proposal.actions || []) {
        try {
          const p = a.payload || {};
          const text = p.title || p.taskTitle || "";
          if (text) {
            const m = moderate(text, "task");
            if (!m.allowed) continue; // defense in depth — never apply unsafe AI text
          }
          const mgId = a.miniGoalId?.toString();
          switch (a.op) {
            case "addTask":
              await ShardM.addTask(null, { miniGoalId: mgId, title: p.title, dueDate: p.dueDate }, context);
              break;
            case "updateTask":
              await ShardM.updateTask(null, { miniGoalId: mgId, taskIndex: a.taskIndex ?? p.taskIndex, title: p.title, dueDate: p.dueDate }, context);
              break;
            case "deleteTask":
              await ShardM.deleteTask(null, { miniGoalId: mgId, taskTitle: p.taskTitle }, context);
              break;
            case "addMiniGoal":
              await ShardM.addMiniGoal(null, { shardId, input: { title: p.title, description: p.description, tasks: p.tasks } }, context);
              break;
            case "updateMiniGoal":
              await ShardM.updateMiniGoal(null, { miniGoalId: mgId, input: { title: p.title, description: p.description, dueDate: p.dueDate } }, context);
              break;
            case "updateShard":
              await ShardM.updateShard(null, { id: shardId, input: { title: p.title, description: p.description } }, context);
              break;
            default:
              continue;
          }
          applied.push(a.op);
        } catch (e) {
          logError("applyQuestAISuggestion:action", e);
        }
      }

      proposal.status = "applied";
      await (msg as any).save();
      await cacheInvalidate.shard(shardId).catch(() => {});

      return { success: true, message: `Applied ${applied.length} change(s).`, applied };
    },

    async dismissQuestAISuggestion(_: any, { messageId }: { messageId: string }, context: any) {
      if (!context.id) ThrowError("Please login to continue.");
      const [msgErr, msg] = await catchError(Message.findById(messageId));
      if (msgErr || !msg || (msg as any).type !== "ai_proposal" || !(msg as any).aiProposal) {
        return { success: false, message: "Proposal not found.", applied: [] };
      }

      // Authorization: only someone with access to the proposal's chat may dismiss it.
      const [, chat] = await catchError(Chat.findById((msg as any).chatId).lean());
      const isParticipant = ((chat as any)?.participants || []).some((p: any) => p.toString() === context.id);
      if (!chat || !isParticipant) {
        return { success: false, message: "Proposal not found.", applied: [] };
      }

      if ((msg as any).aiProposal.status === "pending") {
        (msg as any).aiProposal.status = "dismissed";
        await (msg as any).save();
      }
      return { success: true, message: "Proposal dismissed.", applied: [] };
    },
  },

  Query: {
    async getQuestAIChat(_: any, { shardId }: { shardId: string }, context: any) {
      if (!context.id) ThrowError("Please login to continue.");

      const [shardErr, shard] = await catchError(Shard.findById(shardId).lean());
      if (shardErr || !shard) return { success: false, message: "Quest not found.", messages: [] };
      if (!hasShardAccess(shard, context.id)) return { success: false, message: "You don't have access to this quest.", messages: [] };

      const [, chat] = await catchError(Chat.findOne({ type: "ai", shardId, participants: context.id }).lean());
      if (!chat) return { success: true, message: "No AI chat yet.", chatId: null, messages: [] };

      const [, msgs] = await catchError(
        Message.find({ chatId: (chat as any)._id, deleted: false }).sort({ _id: 1 }).limit(100).lean()
      );
      return {
        success: true,
        chatId: (chat as any)._id.toString(),
        messages: ((msgs as any[]) || []).map(toQAIMessage),
      };
    },
  },
};
