const P = await import('./dist/Helpers/Progress.js');
const S = await import('./dist/Helpers/Streak.js');
const E = await import('./dist/Helpers/Entitlements.js');
let bad = 0;
const ck = (n, c, extra='') => { c ? console.log(`  ✓ ${n}`) : (bad++, console.log(`  ✗ ${n} ${extra}`)); };

console.log('— Payout edge cases —');
// A shard with no tasks: what does completion pay?
ck('an empty shard at 0% pays nothing (not the fallback 200)',
   P.shardCompletionXP(undefined, { onTime: true, completion: 0 }).total === 0);
ck('rounding cannot produce a fractional payout',
   Number.isInteger(P.shardCompletionXP([{type:'xp',value:333}], {onTime:true, completion:37}).total));

console.log('\n— Weighted progress edge cases —');
ck('a mini-goal of only deleted tasks is 0%, not NaN',
   P.miniGoalProgress([{ deleted: true, xpReward: 20 }]) === 0);
ck('all-zero rewards do not divide by zero',
   Number.isFinite(P.miniGoalProgress([{ xpReward: 0, completed: true }, { xpReward: 0 }])));
ck('negative progress input is clamped',
   P.shardCompletionXP([{type:'xp',value:400}], {onTime:false, completion:-50}).total === 0);

console.log('\n— Trial boundary conditions —');
const DAY = 86400000, ago = n => new Date(Date.now() - n*DAY);
// A user who completed a quest BEFORE the trial concept shipped.
ck('a milestone earlier than trial start does not produce a negative window',
   E.trialDaysRemaining({ subscriptionTier:'free', trialStartedAt: ago(2),
     trialEndsAt: new Date(Date.now()+28*DAY), firstQuestCompletedAt: ago(10) }) >= 0);
ck('trialEndsAt with no trialStartedAt still resolves',
   E.trialEndsAtEffective({ subscriptionTier:'free', trialEndsAt: new Date(Date.now()+5*DAY) }) !== null);
ck('trialStartedAt with no trialEndsAt caps at TRIAL_MAX_DAYS', (() => {
   const end = E.trialEndsAtEffective({ subscriptionTier:'free', trialStartedAt: ago(1) });
   return end !== null && end <= Date.now() + E.TRIAL_MAX_DAYS*DAY;
})());

console.log('\n— Streak day-key arithmetic across DST —');
// US DST transition: 2026-03-08 in America/New_York.
const { dateKeyInZone } = await import('./dist/Helpers/Timezone.js');
const beforeDst = new Date('2026-03-07T18:00:00Z');
const afterDst  = new Date('2026-03-09T18:00:00Z');
ck('day keys advance by exactly 2 across a DST boundary',
   S.daysBetweenKeys(dateKeyInZone(beforeDst,'America/New_York'), dateKeyInZone(afterDst,'America/New_York')) === 2,
   `${dateKeyInZone(beforeDst,'America/New_York')} → ${dateKeyInZone(afterDst,'America/New_York')}`);
ck('a streak survives the DST night', S.evaluateRollover(
   { _id:{toString:()=>'u'}, currentStreak:5, streakFreezeTokens:0,
     lastStreakDayKey: dateKeyInZone(new Date('2026-03-07T18:00:00Z'),'America/New_York') },
   dateKeyInZone(new Date('2026-03-08T18:00:00Z'),'America/New_York')) === null);

console.log(`\n${bad === 0 ? '✅ no lapses found' : `❌ ${bad} lapse(s)`}`);
