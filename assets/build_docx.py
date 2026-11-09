# -*- coding: utf-8 -*-
"""thesis_build 的 python-docx 排版引擎。

由插件调用：`python build_docx.py <config.json>`。配置项：

    root       论文工作区根（必填）
    out        输出 docx 的绝对路径（必填）
    title      题目（封面与正文页眉都用它）
    school / college / major / student / student_id / advisor / date  封面信息，缺省留空占位
    toc        是否插入目录域，默认 true

读取约定（与论文工作区一致，缺哪个就跳过哪块）：

    06-论文/摘要.md        前置部分（可选）
    06-论文/章节/*.md      正文，按文件名排序
    06-论文/参考文献.md    文末参考文献（可选，每行一条）

产物：带封面 / 目录域 / 分节页码（罗马→阿拉伯）/ 页眉横线 / 三线表的 .docx。
G2 验收清单属于过程材料，不进正文。
"""
import argparse
import datetime
import json
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

ROOT = Path(".")
THESIS = ROOT / "06-论文"
OUT = THESIS / "产出" / "论文.docx"
TITLE = ""
SCHOOL = ""
COLLEGE = ""
MAJOR = ""
STUDENT = ""
STUDENT_ID = ""
ADVISOR = ""
DATE_TEXT = ""
WITH_TOC = True

BODY_FONT_CN = "宋体"
BODY_FONT_EN = "Times New Roman"
HEAD_FONT_CN = "黑体"
CODE_FONT = "Consolas"

# 分节后第一段的「段前分页」要抑制，否则会多出空白页。
PENDING_SECTION_START = {"flag": False}
TOC_TAB_TWIPS = 8788  # 15.5 cm 处的右对齐制表位，目录用点线引导

PPR_ORDER = ["pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl",
             "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens",
             "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE",
             "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind",
             "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection",
             "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr",
             "sectPr", "pPrChange"]


def ppr_insert(ppr, el):
    """按 OOXML 顺序插入 pPr 子元素（顺序错了 Word 会报“内容有问题”）。"""
    tag = el.tag.split("}")[1]
    index = PPR_ORDER.index(tag) if tag in PPR_ORDER else 99
    for child in list(ppr):
        child_tag = child.tag.split("}")[1]
        if child_tag in PPR_ORDER and PPR_ORDER.index(child_tag) > index:
            child.addprevious(el)
            return
    ppr.append(el)


def setup_page(section):
    section.page_height = Cm(29.7)
    section.page_width = Cm(21.0)
    section.top_margin = Cm(2.5)
    section.bottom_margin = Cm(2.5)
    section.left_margin = Cm(3.0)
    section.right_margin = Cm(2.5)
    section.header_distance = Cm(1.5)
    section.footer_distance = Cm(1.75)


def add_toc_styles(doc):
    """目录条目样式：五号宋体、1.5 倍行距、点线引导到右边界；超链接不用蓝色下划线。"""
    for level, indent in ((1, 0.0), (2, 0.74), (3, 1.48)):
        name = f"TOC {level}"
        try:
            style = doc.styles[name]
        except KeyError:
            style = doc.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
        style.base_style = doc.styles["Normal"]
        style.font.size = Pt(12)
        rpr = style.element.get_or_add_rPr()
        rfonts = rpr.find(qn("w:rFonts"))
        if rfonts is None:
            rfonts = OxmlElement("w:rFonts")
            rpr.append(rfonts)
        rfonts.set(qn("w:eastAsia"), BODY_FONT_CN)
        rfonts.set(qn("w:ascii"), BODY_FONT_EN)
        rfonts.set(qn("w:hAnsi"), BODY_FONT_EN)
        pf = style.paragraph_format
        pf.left_indent = Cm(indent)
        pf.line_spacing = 1.5
        pf.space_before = Pt(0)
        pf.space_after = Pt(0)
        ppr = style.element.get_or_add_pPr()
        tabs = OxmlElement("w:tabs")
        tab = OxmlElement("w:tab")
        tab.set(qn("w:val"), "right")
        tab.set(qn("w:leader"), "dot")
        tab.set(qn("w:pos"), str(TOC_TAB_TWIPS))
        tabs.append(tab)
        ppr_insert(ppr, tabs)
    try:
        link = doc.styles["Hyperlink"]
    except KeyError:
        link = doc.styles.add_style("Hyperlink", WD_STYLE_TYPE.CHARACTER)
    link.font.color.rgb = RGBColor(0x00, 0x00, 0x00)
    link.font.underline = False


def set_run_font(run, cn=BODY_FONT_CN, en=BODY_FONT_EN, size=12, bold=False, color=None):
    run.font.name = en
    run.font.size = Pt(size)
    run.font.bold = bold
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), cn)
    rfonts.set(qn("w:ascii"), en)
    rfonts.set(qn("w:hAnsi"), en)
    if color is not None:
        run.font.color.rgb = RGBColor(*color)


def add_field(paragraph, instr, dirty=False):
    run = paragraph.add_run()
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    if dirty:
        # 让 Word 打开文档时提示/自动更新域，目录页码不用手动 F9
        fld_begin.set(qn("w:dirty"), "true")
    instr_el = OxmlElement("w:instrText")
    instr_el.set(qn("xml:space"), "preserve")
    instr_el.text = instr
    fld_sep = OxmlElement("w:fldChar")
    fld_sep.set(qn("w:fldCharType"), "separate")
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    run._r.append(fld_begin)
    run._r.append(instr_el)
    run._r.append(fld_sep)
    run._r.append(fld_end)


def set_page_numbering(section, fmt, start=1):
    """按节设置页码格式：upperRoman / decimal，并指定起始值。"""
    sectPr = section._sectPr
    old = sectPr.find(qn("w:pgNumType"))
    if old is not None:
        sectPr.remove(old)
    el = OxmlElement("w:pgNumType")
    el.set(qn("w:fmt"), fmt)
    el.set(qn("w:start"), str(start))
    cols = sectPr.find(qn("w:cols"))
    if cols is not None:
        cols.addprevious(el)
    else:
        sectPr.append(el)


def page_number_footer(section):
    """页脚居中页码，`— 1 —` 形式（中文论文常用）。"""
    footer = section.footer
    footer.is_linked_to_previous = False
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for text in ("— ", None, " —"):
        if text is None:
            add_field(p, "PAGE")
        else:
            set_run_font(p.add_run(text), size=10.5)
    for r in p.runs:
        set_run_font(r, size=10.5)


def header_with_rule(section, text):
    """页眉：小五宋体居中，下方一条横线（学校模板常见要求）。"""
    header = section.header
    header.is_linked_to_previous = False
    p = header.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    if text:
        set_run_font(p.add_run(text), size=9)
    ppr = p._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "4")
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), "auto")
    borders.append(bottom)
    ppr_insert(ppr, borders)


def clear_header_footer(section):
    """封面：不要页眉页脚。"""
    section.header.is_linked_to_previous = False
    section.footer.is_linked_to_previous = False
    for container in (section.header, section.footer):
        p = container.paragraphs[0]
        p.text = ""


def body_paragraph(doc, text):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    pf.first_line_indent = Cm(0.85)
    pf.line_spacing_rule = WD_LINE_SPACING.ONE_POINT_FIVE
    pf.space_after = Pt(0)
    add_inline(p, text)
    return p


INLINE_RE = re.compile(r"(\*\*[^*]+\*\*|`[^`]+`)")


def add_inline(paragraph, text, size=12):
    pos = 0
    for m in INLINE_RE.finditer(text):
        if m.start() > pos:
            r = paragraph.add_run(text[pos:m.start()])
            set_run_font(r, size=size)
        token = m.group(0)
        if token.startswith("**"):
            r = paragraph.add_run(token[2:-2])
            set_run_font(r, size=size, bold=True)
        else:
            r = paragraph.add_run(token[1:-1])
            set_run_font(r, cn=CODE_FONT, en=CODE_FONT, size=size - 1.5, color=(0x33, 0x33, 0x33))
        pos = m.end()
    if pos < len(text):
        r = paragraph.add_run(text[pos:])
        set_run_font(r, size=size)


def heading(doc, text, level, outline=True, page_break=None):
    """章节标题。outline=False 时不写大纲级别——「目  录」这种标题不能出现在目录里。"""
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(12 if level == 1 else 9)
    pf.space_after = Pt(6)
    pf.line_spacing_rule = WD_LINE_SPACING.SINGLE
    if level == 1:
        if page_break is None:
            page_break = not PENDING_SECTION_START["flag"]
        PENDING_SECTION_START["flag"] = False
        pf.page_break_before = page_break
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        size = 16
    elif level == 2:
        size = 14
    else:
        size = 12
    r = p.add_run(text)
    set_run_font(r, cn=HEAD_FONT_CN, size=size, bold=True)
    if outline:
        # keep outline level so Word navigation and the TOC field work
        ppr = p._p.get_or_add_pPr()
        outline_el = OxmlElement("w:outlineLvl")
        outline_el.set(qn("w:val"), str(level - 1))
        ppr_insert(ppr, outline_el)
    return p


TABLE_SIZE = 10.5      # 五号
TABLE_WIDTH_CM = 15.5  # 正文栏宽


def _border(tag, val, sz, color="000000"):
    el = OxmlElement(tag)
    el.set(qn("w:val"), val)
    el.set(qn("w:sz"), str(sz))
    el.set(qn("w:space"), "0")
    el.set(qn("w:color"), color)
    return el


TBLPR_ORDER = ["tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize",
               "tblStyleColBandSize", "tblW", "jc", "tblCellSpacing", "tblInd", "tblBorders",
               "shd", "tblLayout", "tblCellMar", "tblLook"]


def normalize_tblPr(tblPr):
    """按 OOXML 架构顺序重排 tblPr 子元素（Word 宽松，但部分阅读器/校验器会挑顺序）。"""
    children = list(tblPr)
    children.sort(key=lambda el: TBLPR_ORDER.index(el.tag.split("}")[1]) if el.tag.split("}")[1] in TBLPR_ORDER else 99)
    for el in children:
        tblPr.remove(el)
    for el in children:
        tblPr.append(el)


def set_three_line(table):
    """三线表：顶线 1.5pt、栏目线 0.75pt（表头下）、底线 1.5pt，无竖线、无内横线。"""
    tblPr = table._tbl.tblPr
    for tag in ("w:tblBorders", "w:tblCellMar", "w:tblLook"):
        old = tblPr.find(qn(tag))
        if old is not None:
            tblPr.remove(old)
    borders = OxmlElement("w:tblBorders")
    borders.append(_border("w:top", "single", 12))
    borders.append(_border("w:left", "none", 0, "auto"))
    borders.append(_border("w:bottom", "single", 12))
    borders.append(_border("w:right", "none", 0, "auto"))
    borders.append(_border("w:insideH", "none", 0, "auto"))
    borders.append(_border("w:insideV", "none", 0, "auto"))
    tblPr.append(borders)
    mar = OxmlElement("w:tblCellMar")
    for side, width in (("top", 50), ("left", 85), ("bottom", 50), ("right", 85)):
        el = OxmlElement(f"w:{side}")
        el.set(qn("w:w"), str(width))
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    tblPr.append(mar)
    look = OxmlElement("w:tblLook")
    look.set(qn("w:val"), "04A0")
    for attr, value in (("w:firstRow", "1"), ("w:lastRow", "0"), ("w:firstColumn", "0"),
                        ("w:lastColumn", "0"), ("w:noHBand", "0"), ("w:noVBand", "1")):
        look.set(qn(attr), value)
    tblPr.append(look)
    normalize_tblPr(tblPr)


def header_rule(cell):
    """表头单元格的下边线（栏目线）。"""
    tcPr = cell._tc.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    borders.append(_border("w:bottom", "single", 6))
    tcPr.append(borders)


def _display_width(text):
    return sum(2 if ord(ch) > 0x2E80 else 1 for ch in text)


def column_widths(rows, ncols, total_cm=TABLE_WIDTH_CM):
    """按内容长度分配列宽：窄列保底、超宽列封顶（否则一列吃掉半张表，其余列全在折行）。"""
    min_cm = 2.4 if ncols <= 4 else (1.9 if ncols >= 7 else 2.1)
    weights = []
    for j in range(ncols):
        longest = max((_display_width(re.sub(r"[`*]", "", r[j])) for r in rows if j < len(r)), default=4)
        weights.append(max(longest, 6))
    fixed = {}
    remaining = total_cm
    pending = list(range(ncols))
    while pending:
        wsum = sum(weights[j] for j in pending)
        narrowed = [j for j in pending if remaining * weights[j] / wsum < min_cm]
        if not narrowed:
            for j in pending:
                fixed[j] = remaining * weights[j] / wsum
            break
        for j in narrowed:
            fixed[j] = min_cm
            remaining -= min_cm
            pending.remove(j)
        if not pending:
            break
    widths = [fixed[j] for j in range(ncols)]
    # 封顶：最宽的列最多占 58%，让出的空间按权重补给其余列。
    cap = total_cm * 0.58 if ncols <= 4 else total_cm
    for _ in range(4):
        excess = 0.0
        for j in range(ncols):
            if widths[j] > cap:
                excess += widths[j] - cap
                widths[j] = cap
        if excess <= 0.01:
            break
        room = [j for j in range(ncols) if widths[j] < cap - 0.01]
        if not room:
            break
        wsum = sum(weights[j] for j in room)
        for j in room:
            widths[j] += excess * weights[j] / wsum
    return widths


NUMERIC_RE = re.compile(r"^[\d\s.,%+\-–—~/×x≈]*\s*(?:ms|s|秒|个|次|%)?$")


def numeric_column(rows, j):
    cells = [r[j].strip() for r in rows[1:] if j < len(r) and r[j].strip() != ""]
    if not cells:
        return False
    return all(NUMERIC_RE.fullmatch(c) and any(ch.isdigit() for ch in c) for c in cells)


def add_table_caption(doc, text):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pf.first_line_indent = Cm(0)
    pf.space_before = Pt(6)
    pf.space_after = Pt(3)
    pf.line_spacing_rule = WD_LINE_SPACING.SINGLE
    r = p.add_run(text)
    set_run_font(r, size=TABLE_SIZE)
    return p


def add_table(doc, rows):
    """按学位论文规范画三线表：表题在上（由 add_table_caption 出力），表内五号字，
    表头加粗居中并在跨页时重复，数字列居中、文字列左对齐。"""
    if not rows:
        return
    ncols = max(len(r) for r in rows)
    size = 9.0 if ncols >= 6 else (10.0 if ncols == 5 else TABLE_SIZE)
    table = doc.add_table(rows=len(rows), cols=ncols)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    set_three_line(table)
    for j, width in enumerate(column_widths(rows, ncols)):
        table.columns[j].width = Cm(width)
        for cell in table.columns[j].cells:
            cell.width = Cm(width)
    for i, row in enumerate(rows):
        header = i == 0
        for j in range(ncols):
            cell = table.cell(i, j)
            cell.text = ""
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            p = cell.paragraphs[0]
            pf = p.paragraph_format
            pf.first_line_indent = Cm(0)
            pf.space_before = Pt(1.5)
            pf.space_after = Pt(1.5)
            pf.line_spacing_rule = WD_LINE_SPACING.SINGLE
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER if (header or numeric_column(rows, j)) else WD_ALIGN_PARAGRAPH.LEFT
            text = row[j] if j < len(row) else ""
            add_inline(p, text, size=size)
            if header:
                for r in p.runs:
                    r.font.bold = True
            if header:
                header_rule(cell)
    # 表头跨页重复
    trPr = table.rows[0]._tr.get_or_add_trPr()
    trPr.append(OxmlElement("w:tblHeader"))
    trPr.append(OxmlElement("w:cantSplit"))
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_before = Pt(0)
    spacer.paragraph_format.space_after = Pt(0)
    spacer.paragraph_format.line_spacing = Pt(9)


def add_code(doc, lines):
    for line in lines:
        p = doc.add_paragraph()
        pf = p.paragraph_format
        pf.first_line_indent = Cm(0)
        pf.left_indent = Cm(0.5)
        pf.line_spacing_rule = WD_LINE_SPACING.SINGLE
        pf.space_after = Pt(0)
        r = p.add_run(line if line else " ")
        set_run_font(r, cn=CODE_FONT, en=CODE_FONT, size=8.5, color=(0x22, 0x22, 0x22))


def png_size(path):
    """读 PNG 的 IHDR 拿像素宽高（不依赖 Pillow：构建脚本要能在裸环境跑）。"""
    try:
        with open(path, "rb") as handle:
            head = handle.read(26)
    except OSError:
        return None
    if head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        return None
    import struct

    width, height = struct.unpack(">II", head[16:24])
    return width, height


def add_figure(doc, image_path, caption):
    """插入一张插图 + 图下方图题（论文规范：图题在图下方、居中、五号）。"""
    if not image_path.exists():
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(f"［图片缺失：{image_path.name}］")
        set_run_font(r, size=10.5, color=(0xAA, 0x33, 0x33))
    else:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        pf = p.paragraph_format
        pf.first_line_indent = Cm(0)
        pf.space_before = Pt(6)
        pf.space_after = Pt(3)
        # 正文栏宽 15.5cm（21 - 3.0 - 2.5），宽图占满 15cm；竖长的流程图按高度封顶，
        # 否则 15cm 宽会把它拉到二十多厘米高，一页放不下、还会挤掉图题。
        size = png_size(image_path)
        if size is None or size[1] <= 0:
            width_cm = 15.0
        else:
            width_cm = max(6.0, min(15.0, 17.0 * size[0] / size[1]))
        p.add_run().add_picture(str(image_path), width=Cm(width_cm))
    cap = doc.add_paragraph()
    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    cpf = cap.paragraph_format
    cpf.first_line_indent = Cm(0)
    cpf.space_before = Pt(0)
    cpf.space_after = Pt(12)
    cpf.line_spacing_rule = WD_LINE_SPACING.SINGLE
    set_run_font(cap.add_run(caption), size=10.5)


def resolve_image(path_text, base_dir):
    """图片路径先按章节文件所在目录解析，再按 06-论文 根解析。"""
    candidate = Path(path_text)
    if candidate.is_absolute():
        return candidate
    for base in (base_dir, THESIS):
        if base is not None:
            resolved = (base / candidate).resolve()
            if resolved.exists():
                return resolved
    return (base_dir or THESIS) / candidate


def add_markdown(doc, text, base_dir=None, skip_checklists=True):
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if skip_checklists and stripped.startswith("## 本章 G2 验收清单"):
            # skip until the next level-2 heading or EOF
            i += 1
            while i < len(lines) and not lines[i].startswith("## "):
                i += 1
            continue
        image = re.fullmatch(r"!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+\"[^\"]*\")?\s*\)", stripped)
        if image is not None:
            add_figure(doc, resolve_image(image.group(2) or image.group(3), base_dir), image.group(1))
            i += 1
            continue
        if stripped.startswith("```"):
            i += 1
            code = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(lines[i].rstrip())
                i += 1
            add_code(doc, code)
            i += 1
            continue
        if re.match(r"^表\s*\d+\s*[-–—]\s*\d+\s+\S", stripped):
            add_table_caption(doc, stripped)
            i += 1
            continue
        if stripped.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                raw = lines[i].strip().strip("|")
                cells = [c.strip() for c in raw.split("|")]
                if not all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
                    rows.append(cells)
                i += 1
            add_table(doc, rows)
            continue
        if stripped.startswith("# "):
            heading(doc, stripped[2:].strip(), 1)
        elif stripped.startswith("## "):
            heading(doc, stripped[3:].strip(), 2)
        elif stripped.startswith("### "):
            heading(doc, stripped[4:].strip(), 3)
        elif stripped.startswith("> "):
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.5)
            r = p.add_run(stripped[2:])
            set_run_font(r, size=10, color=(0x66, 0x66, 0x66))
        elif stripped.startswith("- [ ]") or stripped.startswith("- [x]"):
            pass
        elif stripped.startswith("- "):
            p = doc.add_paragraph(style="List Bullet")
            add_inline(p, stripped[2:])
        elif stripped == "":
            pass
        else:
            body_paragraph(doc, stripped)
        i += 1


def build():
    doc = Document()
    add_toc_styles(doc)
    setup_page(doc.sections[0])
    clear_header_footer(doc.sections[0])

    # ---------- cover ----------
    for _ in range(3):
        doc.add_paragraph()
    if SCHOOL:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(SCHOOL)
        set_run_font(r, cn=HEAD_FONT_CN, size=26, bold=True)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("本科毕业设计（论文）")
    set_run_font(r, cn=HEAD_FONT_CN, size=22, bold=True)

    for _ in range(3):
        doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("题目：" + TITLE)
    set_run_font(r, cn=HEAD_FONT_CN, size=18, bold=True)

    for _ in range(5):
        doc.add_paragraph()
    for label, value in [
        ("学    院", COLLEGE),
        ("专    业", MAJOR),
        ("学    生", STUDENT),
        ("学    号", STUDENT_ID),
        ("指导教师", ADVISOR),
    ]:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(f"{label}：{value if value else '____________'}")
        set_run_font(r, size=14)

    for _ in range(3):
        doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(DATE_TEXT)
    set_run_font(r, size=14)

    # ---------- 前置部分：摘要 / Abstract / 目录（罗马数字页码） ----------
    front = doc.add_section(WD_SECTION.NEW_PAGE)
    setup_page(front)
    page_number_footer(front)
    set_page_numbering(front, "upperRoman", 1)
    PENDING_SECTION_START["flag"] = True

    abstract_path = THESIS / "摘要.md"
    if abstract_path.exists():
        add_markdown(doc, abstract_path.read_text(encoding="utf-8"), base_dir=THESIS, skip_checklists=False)

    if WITH_TOC:
        # 目录标题不进目录：不写大纲级别
        heading(doc, "目  录", 1, outline=False)
        p = doc.add_paragraph()
        add_field(p, 'TOC \\o "1-3" \\h \\z \\u', dirty=True)

    # ---------- 正文：第 1~7 章（阿拉伯数字页码，从 1 开始） ----------
    body = doc.add_section(WD_SECTION.NEW_PAGE)
    setup_page(body)
    header_with_rule(body, TITLE)
    page_number_footer(body)
    set_page_numbering(body, "decimal", 1)
    PENDING_SECTION_START["flag"] = True

    chapter_files = sorted((THESIS / "章节").glob("*.md"))
    for f in chapter_files:
        add_markdown(doc, f.read_text(encoding="utf-8"), base_dir=f.parent)

    # ---------- references ----------
    refs_path = THESIS / "参考文献.md"
    refs = refs_path.read_text(encoding="utf-8") if refs_path.exists() else ""
    for line in refs.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("# "):
            heading(doc, s[2:], 1)
            continue
        p = doc.add_paragraph()
        pf = p.paragraph_format
        pf.left_indent = Cm(0.95)
        pf.first_line_indent = Cm(-0.95)
        pf.line_spacing_rule = WD_LINE_SPACING.ONE_POINT_FIVE
        pf.space_after = Pt(0)
        pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        add_inline(p, s, size=10.5)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUT)
    print(f"saved {OUT} ({OUT.stat().st_size} bytes)")


def main(argv=None):
    global ROOT, THESIS, OUT, TITLE, SCHOOL, COLLEGE, MAJOR, STUDENT, STUDENT_ID, ADVISOR, DATE_TEXT, WITH_TOC
    parser = argparse.ArgumentParser(description="用 python-docx 把论文 Markdown 排成 docx")
    parser.add_argument("config", help="JSON 配置文件路径")
    args = parser.parse_args(argv)
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    if not config.get("root") or not config.get("out"):
        parser.error("配置必须包含 root 与 out")

    ROOT = Path(config["root"]).resolve()
    THESIS = ROOT / "06-论文"
    OUT = Path(config["out"]).resolve()
    TITLE = config.get("title") or "本科毕业设计（论文）"
    SCHOOL = config.get("school") or ""
    COLLEGE = config.get("college") or ""
    MAJOR = config.get("major") or ""
    STUDENT = config.get("student") or ""
    STUDENT_ID = config.get("student_id") or ""
    ADVISOR = config.get("advisor") or ""
    if config.get("date"):
        DATE_TEXT = config["date"]
    else:
        today = datetime.date.today()
        DATE_TEXT = f"{today.year} 年 {today.month} 月"
    WITH_TOC = bool(config.get("toc", True))
    build()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # 让插件拿到一行可读原因，而不是整段 traceback 的尾巴
        print(f"[build_docx] 失败：{error}", file=sys.stderr)
        raise
