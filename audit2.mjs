const S = await import('./dist/Helpers/Streak.js');
const P = await import('./dist/Helpers/Progress.js');

console.log('— Can a 0%-complete quest be cashed in for full XP? —');
const empty = P.shardCompletionXP([{type:'xp',value:400}], {onTime:true, completion:0});
const done  = P.shardCompletionXP([{type:'xp',value:400}], {onTime:true, completion:100});
console.log(`  0% complete pays: ${empty.total}`);
console.log(`  100% complete pays: ${done.total}`);
console.log(empty.total === done.total
  ? '  ✗ EXPLOIT: create → complete immediately → full payout, repeatable'
  : '  ✓ payout scales with real progress');

console.log('\n— Freeze burn while a user is fully absent —');
let freezes = 3, lastKey = '2026-07-01', streak = 12, burned = 0;
for (let d = 2; d <= 8; d++) {
  const today = `2026-07-0${d}`;
  const o = S.evaluateRollover(
    {_id:{toString:()=>'u'}, currentStreak:streak, longestStreak:20, previousStreak:0,
     streakFreezeTokens:freezes, lastStreakDayKey:lastKey},
    today
  );
  if (!o) continue;
  if (o.frozen) { freezes = o.freezesRemaining; burned++; lastKey = S.dayKeyOffsetFromKey(today,-1); }
  else { console.log(`  broke on ${today} after burning ${burned} freeze(s)`); break; }
}
console.log(burned > 1
  ? `  ⚠ a departed user burns ${burned} freezes before breaking — none left for their actual return`
  : '  ✓ at most one freeze per absence');
