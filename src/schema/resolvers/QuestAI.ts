import mongoose from "mongoose";
import { catchError, logError, ThrowError } from "../../Helpers/Helpers.js";
import Shard from "../../models/Shard.js";
import MiniGoal from "../../models/MiniGoal.js";
import { User } from "../../models/User.js";
import Chat, { Message } from "../../models/Chat.js";
import { tierOf, upgradeError } from "../../Helpers/Entitlements.js";
import { formatBriefForPrompt } from "../../Helpers/Intake.js";
import { chatAboutShard } from "../../Helpers/AIHelper.js";
import { moderate } from "../../Helpers/ContentModerator.js";
import { cacheInvalidate } from "../../Helpers/Cache.js";
import ShardResolvers from "./Shard.js";
import { getSocketIO } from "./Chat.js";

const ShardM: any = ShardResolvers.Mutation;

/**
 * Per-user, per-24h ceiling on AI Quest Coach messages.
 *
 * Sized as a cost guard rather than a quota: a real coaching session is a
 * handful of messages, so this should be invisible to normal use and only bite
 * on automation or abuse.
 */
export const COACH_DAILY_MESSAGE_CAP = Number(process.env.COACH_DAILY_MESSAGE_CAP ?? 50);

/**
 * Socket.IO handle, injected from index.ts via Chat.ts's setSocketIO.
 *
 * Read lazily rather than imported at module load: Chat.ts assigns it after the
 * server boots, so capturing it at import time would pin `null` forever.
 */
function getIO(): any {
  return getSocketIO();
}

/**
 * Push a coach message to everyone in the chat room in real time.
 *
 * Without this the AI's reply only appears for whoever asked, and only on their
 * next refetch — which defeats the entire point of moving the coach into the
 * group chat. Fire-and-forget: a socket failure must never fail the mutation,
 * since the message is already persisted and will load on next fetch.
 */
function emitToChat(chatId: string, msg: any, senderId: string, sender: any) {
  if (!msg) return;
  try {
    getIO()?.to(`chat:${chatId}`).emit("message:new", {
      id: msg._id.toString(),
      chatId,
      sender: senderId,
      senderUsername: sender?.username || "Unknown",
      senderProfilePic: sender?.profilePic || "",
      content: msg.content,
      type: msg.type,
      createdAt: msg.createdAt,
    });
  } catch {
    // Non-fatal — the message is persisted regardless.
  }
}

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

/** A resolved (mini-goal, optional task) target for a scoped question. */
interface ScopedTarget {
  miniGoal: any;
  taskIndex?: number;
  task?: any;
  siblings: any[];
}

/**
 * Resolve `miniGoalId` / `taskIndex` against the quest's own mini-goals.
 *
 * Returns null when the mini-goal isn't part of this quest — the caller turns
 * that into a rejection rather than silently widening back to whole-quest
 * context, so a bad id can't be used to probe another quest's structure.
 */
function resolveScope(
  miniGoals: any[],
  miniGoalId?: string | null,
  taskIndex?: number | null
): ScopedTarget | null {
  if (!miniGoalId) return null;

  const miniGoal = miniGoals.find((mg) => mg._id.toString() === miniGoalId);
  if (!miniGoal) return null;

  const open = (miniGoal.tasks || []).filter((t: any) => !t.deleted);

  if (typeof taskIndex !== "number") {
    return { miniGoal, siblings: open };
  }

  const task = (miniGoal.tasks || [])[taskIndex];
  if (!task || task.deleted) return { miniGoal, siblings: open };

  return { miniGoal, taskIndex, task, siblings: open };
}

/**
 * Context for a question about one task (or one mini-goal).
 *
 * Deliberately still includes the quest title and the sibling tasks: advice about
 * a single step is worthless without knowing what it is a step *toward*, and
 * whether the work either side of it is already done.
 */
function buildTaskContext(shard: any, scope: ScopedTarget): string {
  const lines: string[] = [
    `Quest: ${shard.title}`,
    `Overall progress: ${shard.progress?.completion ?? 0}%`,
    "",
    `Mini-goal [id: ${scope.miniGoal._id}] "${scope.miniGoal.title}"${scope.miniGoal.completed ? " (completed)" : ""}`,
  ];

  if (scope.task) {
    lines.push(
      "",
      `THE USER IS ASKING ABOUT THIS TASK:`,
      `  task[${scope.taskIndex}] "${scope.task.title}"${scope.task.completed ? " ✓ done" : ""}${scope.task.overdue ? " ⚠ overdue" : ""}`,
      scope.task.dueDate ? `  due: ${new Date(scope.task.dueDate).toDateString()}` : "  due: unscheduled",
      "",
      "Other tasks in the same mini-goal, for context:"
    );
    scope.siblings.forEach((t: any, i: number) => {
      if (i === scope.taskIndex) return;
      lines.push(`  - task[${i}] ${t.title}${t.completed ? " ✓" : ""}`);
    });
  } else {
    lines.push("", "THE USER IS ASKING ABOUT THIS MINI-GOAL. Its tasks:");
    scope.siblings.forEach((t: any, i: number) =>
      lines.push(`  - task[${i}] ${t.title}${t.completed ? " ✓" : ""}`)
    );
  }

  return lines.join("\n");
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
    async chatWithQuestAI(
      _: any,
      { shardId, message, miniGoalId, taskIndex }: {
        shardId: string;
        message: string;
        miniGoalId?: string | null;
        taskIndex?: number | null;
      },
      context: any
    ) {
      if (!context.id) ThrowError("Please login to continue.");

      const msgMod = moderate(message, "goal");
      if (!msgMod.allowed) {
        return { success: false, message: msgMod.crisisMessage || msgMod.reason || "Message not allowed.", messages: [] };
      }

      const [shardErr, shard] = await catchError(Shard.findById(shardId).lean());
      if (shardErr || !shard) return { success: false, message: "Quest not found." };
      if (!hasShardAccess(shard, context.id)) return { success: false, message: "You don't have access to this quest." };

      // Pro gate — AI Quest Coach is a Pro feature
      const [, user] = await catchError(User.findById(context.id, "subscriptionTier role trialStartedAt trialEndsAt firstQuestCompletedAt username profilePic").lean());
      if (tierOf(user as any) !== "pro") {
        return upgradeError("AI Quest Coach is a Pro feature. Upgrade to chat with your coach and refine quests!");
      }

      // Display identity for the chat card. In a group chat the reply carries the
      // asker's name, so participants can see who prompted the coach.
      const asker = user as any;

      // Daily cap. Pro is unlimited *quests*, not unlimited inference: this path
      // runs the 70B model on every message, so without a ceiling a single user
      // can spend more on tokens in a day than their subscription earns in a
      // month. The limit is set well above ordinary use — it exists to bound the
      // tail, not to ration the feature.
      // Counted off `ai_reply`, which is written with the requesting user as
      // `sender` — so this is one indexed query on { sender, createdAt } and
      // needs no join back to the AI chats. It also counts what actually costs
      // money (replies generated) rather than messages typed.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [, coachRepliesToday] = await catchError(
        Message.countDocuments({
          sender: context.id,
          type: "ai_reply",
          createdAt: { $gte: since },
        })
      );

      if ((coachRepliesToday ?? 0) >= COACH_DAILY_MESSAGE_CAP) {
        return {
          success: false,
          message: `You've reached today's coach limit (${COACH_DAILY_MESSAGE_CAP} messages). It resets in 24 hours.`,
          messages: [],
        };
      }

      // Where the conversation lives.
      //
      // A collaborative quest routes the coach through the SHARD GROUP CHAT, so
      // every participant sees the question and the answer. Coaching a shared goal
      // in a private thread meant the one useful artefact — "here's how we should
      // restructure week 3" — was visible only to whoever typed it, and the
      // accountability partner, whose entire job is to know this, saw nothing.
      //
      // A solo quest has no group chat (createShard only makes one when there are
      // participants), so it falls back to the private thread. Same feature, and
      // no empty chat rooms for people working alone.
      const isGroupCoaching = !!(shard as any).chatId;
      let chat: any;

      if (isGroupCoaching) {
        const [chatErr, groupChat] = await catchError(Chat.findById((shard as any).chatId));
        if (chatErr || !groupChat) return { success: false, message: "Quest chat not found.", messages: [] };
        chat = groupChat;
      } else {
        const [, existing] = await catchError(
          Chat.findOne({ type: "ai", shardId, participants: context.id })
        );
        chat = existing;
        if (!chat) {
          const [createErr, created] = await catchError(
            Chat.create({ type: "ai", shardId, participants: [context.id], name: `AI Coach: ${(shard as any).title}` })
          );
          if (createErr || !created) return { success: false, message: "Failed to start AI chat.", messages: [] };
          chat = created;
        }
      }

      const [, miniGoals] = await catchError(
        MiniGoal.find({ shardId }).sort({ order: 1, createdAt: 1 }).lean()
      );

      // Scope the context to one task when asked about one. Handing the model the
      // entire quest to answer "why is this step blocked?" buries the subject in
      // noise and invites it to propose changes nobody asked for.
      const scoped = resolveScope((miniGoals as any[]) || [], miniGoalId, taskIndex);
      if (miniGoalId && !scoped) {
        return { success: false, message: "That task is not part of this quest.", messages: [] };
      }

      // The brief is what the user said this quest was FOR. Without it the coach
      // re-derives intent from the title on every reply, which is how it ends up
      // giving advice the user already ruled out at intake.
      const shardContext =
        (scoped
          ? buildTaskContext(shard, scoped)
          : buildShardContext(shard, (miniGoals as any[]) || [])) +
        formatBriefForPrompt((shard as any)?.brief);

      const [, recent] = await catchError(
        Message.find({ chatId: chat._id, type: { $in: ["text", "ai_reply"] }, deleted: false })
          .sort({ _id: -1 })
          .limit(10)
          .lean()
      );
      const history = ((recent as any[]) || [])
        .reverse()
        .map((m: any) => `${m.type === "ai_reply" ? "Coach" : "User"}: ${m.content}`)
        .join("\n");

      // Persist the user's message
      const [, userMsg] = await catchError(
        Message.create({ chatId: chat._id, sender: context.id, content: message, type: "text", readBy: [context.id] })
      );
      emitToChat(chat._id.toString(), userMsg, context.id, asker);

      const result = await chatAboutShard(message, shardContext, history);

      // Persist the AI reply
      const [, replyMsg] = await catchError(
        Message.create({ chatId: chat._id, sender: context.id, content: result.reply, type: "ai_reply", readBy: [context.id] })
      );
      emitToChat(chat._id.toString(), replyMsg, context.id, asker);

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
            chatId: chat._id,
            sender: context.id,
            content: result.proposal.summary || "Suggested changes to your quest",
            type: "ai_proposal",
            readBy: [context.id],
            aiProposal: { status: "pending", summary: result.proposal.summary, actions },
          })
        );
        proposalMsg = created;
        emitToChat(chat._id.toString(), created, context.id, asker);
      }

      return {
        success: true,
        message: "OK",
        chatId: chat._id.toString(),
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

      // Authorization: chat membership is necessary but no longer sufficient.
      //
      // Now that proposals land in the shared quest chat, "any participant" would
      // let a collaborator dismiss a plan change the owner is still considering —
      // pure griefing, and invisible afterwards since the card just reads
      // "dismissed". Narrow it to the two people with a legitimate claim: the
      // quest owner (who alone can apply it, see applyQuestAISuggestion) and
      // whoever asked the question that produced it.
      const [, chat] = await catchError(Chat.findById((msg as any).chatId).lean());
      const isParticipant = ((chat as any)?.participants || []).some((p: any) => p.toString() === context.id);
      if (!chat || !isParticipant) {
        return { success: false, message: "Proposal not found.", applied: [] };
      }

      const isAsker = (msg as any).sender?.toString() === context.id;
      let mayDismiss = isAsker;

      if (!mayDismiss) {
        const shardId = (chat as any)?.shardId?.toString();
        const [, shard] = await catchError(Shard.findById(shardId).select("owner").lean());
        mayDismiss = (shard as any)?.owner?.toString() === context.id;
      }

      if (!mayDismiss) {
        return {
          success: false,
          message: "Only the quest owner or whoever asked can dismiss this suggestion.",
          applied: [],
        };
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
