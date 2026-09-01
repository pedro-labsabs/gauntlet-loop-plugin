/**
 * Locale dictionaries for the Gauntlet toolview.
 */
export const NS = 'gauntlet' as const

export type GauntletKey =
  | 'row.running' | 'row.blocked' | 'row.complete' | 'row.halted'
  | 'row.next' | 'row.won' | 'row.pending' | 'row.awaitingCritique' | 'row.rebuild'
  | 'row.blockedHeading' | 'row.error' | 'row.rejections'
  | 'row.builder' | 'row.critic' | 'row.verdict' | 'row.evidence' | 'row.notes'
  | 'row.artifact' | 'row.summary' | 'row.lessons' | 'row.barLabel' | 'row.roundLabel'
  | 'row.unavailable' | 'row.progress' | 'row.phase' | 'row.ours' | 'row.bar'
  | 'row.status' | 'row.gauntlet' | 'row.expand' | 'row.collapse' | 'row.inspect' | 'row.reason'

export const en: Record<GauntletKey, string> = {
  'row.gauntlet': 'Gauntlet',
  'row.running': 'Running',
  'row.blocked': 'Blocked',
  'row.complete': 'Complete',
  'row.halted': 'Halted',
  'row.next': 'Next',
  'row.won': 'Won',
  'row.pending': 'Pending',
  'row.awaitingCritique': 'Waiting critique',
  'row.rebuild': 'Rebuild',
  'row.blockedHeading': 'BLOCKED',
  'row.error': 'Error',
  'row.rejections': 'Rejections',
  'row.builder': 'Builder',
  'row.critic': 'Critic',
  'row.verdict': 'Verdict',
  'row.evidence': 'Evidence',
  'row.notes': 'Notes',
  'row.artifact': 'Artifact',
  'row.summary': 'Summary',
  'row.lessons': 'Lessons',
  'row.barLabel': 'Bar',
  'row.roundLabel': 'Round',
  'row.unavailable': 'Gauntlet workbench unavailable',
  'row.progress': '{won}/{total} units',
  'row.phase': 'Phase',
  'row.ours': 'Ours',
  'row.bar': 'Bar',
  'row.status': 'Status',
  'row.expand': 'Expand gauntlet',
  'row.collapse': 'Collapse gauntlet',
  'row.inspect': 'Inspect',
  'row.reason': 'Reason',
}

export const zh: Record<GauntletKey, string> = {
  'row.gauntlet': 'Gauntlet',
  'row.running': '运行中',
  'row.blocked': '阻塞',
  'row.complete': '完成',
  'row.halted': '已停止',
  'row.next': '下一步',
  'row.won': '通过',
  'row.pending': '待处理',
  'row.awaitingCritique': '等待评审',
  'row.rebuild': '重建',
  'row.blockedHeading': '阻塞',
  'row.error': '错误',
  'row.rejections': '拒绝原因',
  'row.builder': '构建者',
  'row.critic': '评审者',
  'row.verdict': '裁定',
  'row.evidence': '证据',
  'row.notes': '备注',
  'row.artifact': '制品',
  'row.summary': '总结',
  'row.lessons': '经验',
  'row.barLabel': '基准',
  'row.roundLabel': '轮次',
  'row.unavailable': 'Gauntlet 工作台不可用',
  'row.progress': '{won}/{total} 单元',
  'row.phase': '阶段',
  'row.ours': '我方',
  'row.bar': '基准',
  'row.status': '状态',
  'row.expand': '展开 Gauntlet',
  'row.collapse': '折叠 Gauntlet',
  'row.inspect': '检查',
  'row.reason': '原因',
}
