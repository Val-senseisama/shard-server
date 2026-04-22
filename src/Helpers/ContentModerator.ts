export type ModerationSeverity = 'pass' | 'warn' | 'block' | 'crisis';

export interface ModerationResult {
  allowed: boolean;
  severity: ModerationSeverity;
  reason?: string;
  /** Only set when severity === 'crisis' — a safe message to return to the user */
  crisisMessage?: string;
}

// ─── Pattern lists ────────────────────────────────────────────────────────────

/**
 * Crisis patterns — do NOT block; return a supportive message and hotline info.
 * Never punish a user for expressing distress.
 */
const CRISIS_PATTERNS: RegExp[] = [
  /\bsuicid(e|al)\b/i,
  /\bkill\s*(my)?self\b/i,
  /\bend\s+my\s+life\b/i,
  /\bwant\s+to\s+die\b/i,
  /\bself[- ]?harm\b/i,
  /\bcut\s+myself\b/i,
  /\boverdos(e|ing)\b/i,
  /\bno\s+reason\s+to\s+live\b/i,
];

/**
 * Criminal / dangerous activity goals.
 * Covers: drug synthesis, weapons, exploitation, violent acts against others.
 * Personal safety goals ("learn self-defence", "buy a legal firearm") are NOT matched.
 */
const CRIMINAL_PATTERNS: RegExp[] = [
  // Drug synthesis
  /\b(make|cook|synthesize|produce|manufacture)\s+(meth(amphetamine)?|heroin|fentanyl|crack|cocaine|mdma)\b/i,
  // Weapons manufacturing
  /\b(build|make|3d[\s-]print|manufacture)\s+(bomb|explosive|landmine|grenade)\b/i,
  /\b(illegally\s+)?(obtain|get|acquire)\s+(guns?|firearms?|weapons?)\b/i,
  // Financial crime
  /\b(phish|scam|defraud|launder\s+money|commit\s+(fraud|theft))\b/i,
  /\bhow\s+to\s+(hack|break\s+into)\s+.{0,30}(account|system|server)\b/i,
  // Exploitation
  /\b(human\s+trafficking|sex\s+trafficking|child\s+(porn|sex|exploit|grooming))\b/i,
  // Targeted violence
  /\b(murder|kill|assault|stalk|rape)\s+.{0,20}(someone|person|people|my|him|her|them)\b/i,
];

/**
 * Hate speech — slurs and dehumanising directives targeting any group.
 * LGBTQ+ identity as a personal goal topic is NOT targeted here.
 * Only slurs and explicit calls for harm are matched.
 *
 * Patterns use obfuscated forms to avoid storing the words verbatim.
 */
const HATE_SPEECH_PATTERNS: RegExp[] = [
  // Racial slurs (partial obfuscation)
  /\bn[i1!]gg[aer]+\b/i,
  /\bch[i1!]nk\b/i,
  /\bsp[i1!]c\b/i,
  /\bk[i1!]k[e3]\b/i,
  /\bw[e3]tb[a4]ck\b/i,
  /\bg[o0]{2}k\b/i,
  // Homophobic / transphobic slurs
  /\bf[a4@]gg?[o0]t\b/i,
  /\btr[a4@]nn[yi]\b/i,
  // Generic group-targeted violence
  /\b(gay|trans|jewish|muslim|black|white|asian|hispanic|immigrant)\s+(people\s+)?(should\s+)?(die|be\s+killed|are\s+subhuman|deserve\s+to\s+die)\b/i,
];

/**
 * Profanity — only enforced on public-facing fields (username, bio).
 * Goal text and task titles are NOT profanity-filtered; a goal like
 * "stop saying f*** at work" is perfectly legitimate.
 */
const PROFANITY_PATTERNS: RegExp[] = [
  /\bf+[u*@#]+c+k+\b/i,
  /\bs+h+[i!1*]+t+\b/i,
  /\ba+s+h+[o0]+l+e+\b/i,
  /\bb+[i!1*]+t+c+h+\b/i,
  /\bc+[u*]+n+t+\b/i,
  /\bc+[o0]+c+k+\b/i,
  /\bd+[i!1]+c+k+\b/i,
  /\bm+[o0]+t+h+e+r+f+[u*@#]+c+k\b/i,
];

// ─── Core moderator ───────────────────────────────────────────────────────────

function matches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Moderate any user-supplied text.
 *
 * @param text        The input to check
 * @param context     Where the text came from — affects which checks run
 */
export function moderate(
  text: string,
  context: 'goal' | 'chat' | 'public_profile' | 'task' = 'goal'
): ModerationResult {
  if (!text || !text.trim()) return { allowed: true, severity: 'pass' };

  // 1. Crisis check — always runs, never blocks, returns supportive message
  if (matches(text, CRISIS_PATTERNS)) {
    return {
      allowed: false,
      severity: 'crisis',
      reason: 'crisis_detected',
      crisisMessage:
        "It sounds like you might be going through something really difficult. Please reach out — you deserve support. 💙\n\n" +
        "🆘 988 Suicide & Crisis Lifeline (US): call or text 988\n" +
        "🌍 International: https://findahelpline.com",
    };
  }

  // 2. Hate speech — always blocked
  if (matches(text, HATE_SPEECH_PATTERNS)) {
    return {
      allowed: false,
      severity: 'block',
      reason: 'This content violates our community guidelines.',
    };
  }

  // 3. Criminal activity — blocked in goal and task contexts
  if (context !== 'chat' && matches(text, CRIMINAL_PATTERNS)) {
    return {
      allowed: false,
      severity: 'block',
      reason: 'We can\'t help with goals that involve illegal or harmful activities.',
    };
  }
  // Also check chat for the most serious criminal patterns
  if (context === 'chat' && matches(text, CRIMINAL_PATTERNS)) {
    return {
      allowed: false,
      severity: 'block',
      reason: 'This message was flagged for potentially harmful content.',
    };
  }

  // 4. Profanity — only enforced on public-facing profile fields
  if (context === 'public_profile' && matches(text, PROFANITY_PATTERNS)) {
    return {
      allowed: false,
      severity: 'warn',
      reason: 'Please keep your profile language clean and respectful.',
    };
  }

  return { allowed: true, severity: 'pass' };
}
