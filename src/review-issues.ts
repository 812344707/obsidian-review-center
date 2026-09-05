export interface IssueAdvice { title: string; solution: string; line?: number }
export function issueAdvice(warning: string): IssueAdvice {
  const match = /第\s*(\d+)\s*行/.exec(warning);
  const line = match ? Math.max(0, Number(match[1]) - 1) : undefined;
  if (/同步冲突/.test(warning)) return { title: "同步评分冲突", solution: "核对当前排程和两台设备的评分。系统已保留冲突记录；先完成同步，必要时从管理页导出备份核对。不要通过重置全部进度来消除提示。", line };
  if (/重复|同一标识|标识冲突/.test(warning)) return { title: "稳定标识重复", solution: "打开原文核对重复位置。保留原卡片的标识；只有确认是新复制的卡片时，才移除副本的 ^rv-… 行，再重新检查生成新标识。无法确定原卡时先保留两份。", line };
  if (/问题为空|答案为空|缺少.*答/.test(warning)) return { title: "问答尚未写完整", solution: "填写“问::”后的问题，并在下一行“答::”后补上答案，保持每行位于同一个 [!review] 块中。写完后重新检查；原有卡片进度会保留。", line };
  if (/挖空编号/.test(warning)) return { title: "填空格式无效", solution: "使用 {{c1::答案}}，编号从 1 开始。也可以选中文字后点“填空”自动插入，随后重新检查。", line };
  if (/未关闭.*代码块/.test(warning)) return { title: "代码块未结束", solution: "补上与开头一致的代码围栏，保持在复习块内；如果不是代码，移除误写的围栏后重新检查。", line };
  if (/不在可识别|提示块类型/.test(warning)) return { title: "卡片离开了复习块", solution: "将原卡片内容和原 ^rv-… 标识一同放回 [!review] 块，再重新检查。不要新建一张同内容卡片替代原卡。", line };
  if (/迁移|转换|旧复习章节/.test(warning)) return { title: "旧材料转换需要核对", solution: "按提示检查旧复习章节与现有复习块是否重叠，保留卡片标识和原文备份；修正后重新检查继续转换。", line };
  return { title: "材料需要核对", solution: "打开原文按具体提示修正，然后重新检查。核实前保留原文、标识和复习进度。", line };
}
