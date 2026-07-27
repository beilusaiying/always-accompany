# -*- coding: utf-8 -*-
"""
style_packs.py —— 风格包（v1.3, 主题适配层）

凛倾评价"没有和主题适配, 都是简单的优化"的根治: theme 从"四色"升级为完整视觉语言包
（参照 frontend-slides/STYLE_PRESETS.md 的形态: vibe+版式母题+signature元素, 拒绝
Generic AI Patterns——那份禁用清单里"所有主题同一版式只换色"正是我们此前的病）。

pack 结构（渲染器消费, 全部可选缺省=v1.2 行为）:
  颜色四件 + cover_title_color  ——向下兼容 themes.py 四色约定
  big_page_number: bool         ——右上超大页码编号(01/02…, Bold Signal 母题)
  divider_style: "band"|"card"  ——章节分隔页样式
  card_style: "tint"|"line"|"none" ——内容卡片风格(tint=v1.2色卡; line=仅左竖条+分隔线, Swiss感)
  title_rule: bool              ——标题下细分隔线(Paper&Ink 母题; 注意官方"标题装饰线=AI味"
                                   禁忌指的是短粗accent线, 全宽极细rule是编辑排版惯例, 区别对待)
  vibe: 文字描述                 ——给 flash 的风格气质说明(prompt 用)
"""

STYLE_PACKS = {
    # 深色发布会感: 深底大色卡+超大页码(tech产品/开源项目)
    "bold_signal": {
        "title_color": "1A1A1A", "body_color": "2B2B2B",
        "bg_color": "FFFFFF", "accent_color": "FF5722",
        "cover_title_color": "FFFFFF", "cover_bg_color": "1A1A1A",
        "big_page_number": True, "divider_style": "band",
        "card_style": "tint", "title_rule": False,
        "vibe": "自信/现代/高冲击, 深色封面+亮橙强调, 大页码编号",
    },
    # 瑞士网格: 纯白黑字红点, 极简精确(工程/技术文档)
    "swiss_modern": {
        "title_color": "000000", "body_color": "1A1A1A",
        "bg_color": "FFFFFF", "accent_color": "FF3300",
        "cover_title_color": "FFFFFF", "cover_bg_color": "000000",
        "big_page_number": True, "divider_style": "card",
        "card_style": "line", "title_rule": False,
        "vibe": "克制/精确/包豪斯, 黑白+红点强调, 网格对齐, 无装饰",
    },
    # v1.8 暗色董事会: 2026 趋势采集(Dark Mode 董事会主流+霓虹teal强调, exp_优秀模板采集.md §1.2);
    # 深底浅字全页暗色, card_style=line 防浅 tint 卡在暗底上刺眼
    "dark_boardroom": {
        "title_color": "FFFFFF", "body_color": "D8DEE9",
        "bg_color": "121826", "accent_color": "2EE6A8",
        "cover_title_color": "FFFFFF", "cover_bg_color": "0B0F1A",
        "big_page_number": True, "divider_style": "band",
        "card_style": "line", "title_rule": False,
        "vibe": "深邃/科技/董事会, 暗夜蓝底+霓虹青强调, 大页码编号",
    },
    # v1.9 暗色科技仪表盘: ppt-master 内容层提炼(GitHub dark 系+金铜强调, slideN.xml 解析)
    "dark_tech": {
        "title_color": "E6EDF3", "body_color": "8B949E",
        "bg_color": "0D1117", "accent_color": "D4A574",
        "cover_title_color": "E6EDF3", "cover_bg_color": "090C10",
        "big_page_number": True, "divider_style": "band",
        "card_style": "line", "title_rule": False,
        "vibe": "工程/终端/仪表盘, GitHub暗底+金铜强调, 大页码编号",
    },
    # v1.9 靛夜玻璃: ppt-master 玻璃拟态内容层提炼(深靛底+霓虹青; 真玻璃卡=多层alpha叠加,
    # 渲染端暂不支持 gradFill 叠层, 先落四色语言, 玻璃卡形态记 CONTRACT 待办)
    "glass_indigo": {
        "title_color": "E8ECFF", "body_color": "A8B0D0",
        "bg_color": "0A0E27", "accent_color": "3DDDFC",
        "cover_title_color": "E8ECFF", "cover_bg_color": "070A1E",
        "big_page_number": True, "divider_style": "band",
        "card_style": "line", "title_rule": False,
        "vibe": "深邃/未来/发布会, 靛夜蓝底+霓虹青强调, 大页码编号",
    },
    # 纸墨编辑: 暖纸底衬线感+分隔线(文档/学术/长文)
    "paper_ink": {
        "title_color": "1A1A1A", "body_color": "2B2B2B",
        "bg_color": "FAF9F7", "accent_color": "C41E3A",
        "cover_title_color": "FAF9F7", "cover_bg_color": "1A1A1A",
        "big_page_number": False, "divider_style": "band",
        "card_style": "line", "title_rule": True,
        "vibe": "编辑部/文学/沉稳, 暖奶油纸底+绯红强调, 细分隔线",
    },
}


# v1.9 数据覆盖层（与 themes.py 同一 loader 单源, 用户 JSON 可编辑覆盖/扩展风格包）
import themes as _themes
STYLE_PACKS.update({str(k).lower(): v for k, v in (_themes._OVERLAY.get("style_packs") or {}).items()
                    if isinstance(v, dict)})


def resolve_style(name_or_dict):
    """风格包解析: dict原样 / 包名查表 / None。与 themes.resolve_theme 并存分层:
    themes=四色皮肤(v0.5兼容), style_packs=完整视觉语言(v1.3)。"""
    if name_or_dict is None or isinstance(name_or_dict, dict):
        return name_or_dict
    return STYLE_PACKS.get(str(name_or_dict).lower())
