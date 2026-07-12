import { ThrowError } from "../../Helpers/Helpers.js";
import { User } from "../../models/User.js";
import Friendship from "../../models/Friendship.js";

interface Entry {
  id: string;
  username: string;
  profilePic?: string;
  xp: number;
  level: number;
  rank: number;
  isMe: boolean;
}

const toEntries = (users: any[], meId: string, offset = 0): Entry[] =>
  users.map((u, i) => ({
    id: u._id.toString(),
    username: u.username,
    profilePic: u.profilePic,
    xp: u.xp || 0,
    level: u.level || 1,
    rank: offset + i + 1,
    isMe: u._id.toString() === meId,
  }));

export default {
  Query: {
    /**
     * XP leaderboard. scope "friends" ranks the user among their accepted friends;
     * "global" returns the top players and the user's global rank.
     */
    async getLeaderboard(
      _: any,
      { scope = "friends", limit = 50 }: { scope?: string; limit?: number },
      context: any
    ) {
      if (!context.id) ThrowError("Please login to continue.");
      const meId = context.id;
      const cap = Math.min(Math.max(limit, 1), 100);

      if (scope === "global") {
        const [top, me] = await Promise.all([
          User.find({}, "username profilePic xp level").sort({ xp: -1, _id: 1 }).limit(cap).lean(),
          User.findById(meId, "xp").lean(),
        ]);
        const myXp = (me as any)?.xp || 0;
        // Rank = how many users have strictly more XP, +1.
        const ahead = await User.countDocuments({ xp: { $gt: myXp } });
        return { success: true, scope, myRank: ahead + 1, entries: toEntries(top, meId) };
      }

      // friends scope — the user plus everyone they're accepted friends with
      const friendships = await Friendship.find(
        { status: "accepted", $or: [{ user: meId }, { friend: meId }] },
        "user friend"
      ).lean();

      const ids = new Set<string>([meId]);
      for (const f of friendships) {
        ids.add(f.user.toString());
        ids.add(f.friend.toString());
      }

      const users = await User.find(
        { _id: { $in: Array.from(ids) } },
        "username profilePic xp level"
      )
        .sort({ xp: -1, _id: 1 })
        .limit(cap)
        .lean();

      const entries = toEntries(users, meId);
      const myRank = entries.find((e) => e.isMe)?.rank || null;
      return { success: true, scope, myRank, entries };
    },
  },
};
