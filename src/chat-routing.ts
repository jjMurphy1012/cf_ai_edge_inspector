export type AuditIntent =
  | { kind: "start_audit"; url: string }
  | { kind: "compare" }
  | { kind: "history" }
  | { kind: "latest" }
  | { kind: "follow_up" }
  | { kind: "empty" };

function trimTarget(text: string) {
  return text.trim().replace(/^[\s("'`<]+|[\s)"'`>,.!?。！？]+$/g, "");
}

/** A URL in a question is context, not permission to start another scan. */
export function classifyIntent(text: string): AuditIntent {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };

  const command =
    trimmed.match(
      /^(?:please\s+)?(?:analyze|audit|inspect|check|review|scan)\s+(.+)$/i
    ) ?? trimmed.match(/^(?:请)?(?:分析|审计|检测|检查|扫描)\s*(.+)$/);
  if (command) {
    const target = trimTarget(command[1]);
    // Keep malformed single-token targets so the URL validator can explain them.
    // "Check the security headers" remains a question about the saved result.
    if (!/\s/.test(target)) return { kind: "start_audit", url: target };
  }

  const target = trimTarget(trimmed);
  if (
    !/\s/.test(target) &&
    (/^[a-z][a-z\d+.-]*:\/\//i.test(target) ||
      /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(
        target
      ))
  )
    return { kind: "start_audit", url: target };

  if (
    /(compare|what changed|difference|previous scan|last scan|对比|比较|变化)/i.test(
      trimmed
    )
  ) {
    return { kind: "compare" };
  }
  if (
    /(history|recent audits|recent scans|past audits|past scans|list audits|历史|记录)/i.test(
      trimmed
    )
  ) {
    return { kind: "history" };
  }
  if (
    /(latest audit|last audit|latest result|last result|show latest|show last|summary|最新结果|摘要|总结)/i.test(
      trimmed
    )
  ) {
    return { kind: "latest" };
  }

  return { kind: "follow_up" };
}
