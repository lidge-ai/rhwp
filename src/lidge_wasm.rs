//! lidge-hwp 전용 읽기 API (브랜치 lidge/studio-host-devel, wp5). 문서를 바꾸지 않는다.
//!
//! `lidgeAuxContent()`는 lidge-hwp의 내용 서명(`lib/signature.mjs`)이 기존 공개 API로 닿지 못하는 글을
//! 문서 순서로 낸다.
//! - 머리말·꼬리말·각주·미주: `getHeaderFooter(section, isHeader, applyTo)`는 같은 적용 범위의 **첫**
//!   컨트롤만 돌려준다(`find_header_footer_control`). KU 참가신청서 .hwp는 구역 0에 양쪽 머리말이 둘이라
//!   두 번째 글을 읽을 길이 없다.
//! - 셀·글상자 안의 표(중첩 표), 표·그림 캡션, 글상자: 칸 주소·병합과 글을 함께 낸다.
//! - 그리기 묶음(그룹)의 자식 개체: 기존 `getScanItems`의 `shape_lists`는 묶음 자식을 따라가지 않는다
//!   (`src/document_core/queries/field_query.rs:1944-1959`). 여기서는 자식마다 다시 들어가 글상자·캡션을 읽는다.
//! 글을 읽을 수 없는 것(수식, 머리말 안의 각주)은 `unsupported`에 이유를 적는다.
//! 서명은 그때 저장을 거부한다.

use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

use crate::model::control::Control;
use crate::model::header_footer::HeaderFooterApply;
use crate::model::paragraph::Paragraph;
use crate::model::shape::ShapeObject;
use crate::wasm_api::HwpDocument;

fn apply_code(apply: &HeaderFooterApply) -> u8 {
    match apply {
        HeaderFooterApply::Both => 0,
        HeaderFooterApply::Even => 1,
        HeaderFooterApply::Odd => 2,
    }
}

/// 문단 묶음의 글을 빠짐없이 편다. 개체는 표식(\u{1}…)으로 경계를 남기고 안으로 들어간다. 글은 다듬지 않는다.
fn flatten(paras: &[Paragraph], in_note: bool, out: &mut Vec<String>, unsupported: &mut Vec<String>) {
    for para in paras {
        out.push(para.text.clone());
        for ctrl in &para.controls {
            flatten_control(ctrl, in_note, out, unsupported);
        }
    }
}

fn flatten_control(ctrl: &Control, in_note: bool, out: &mut Vec<String>, unsupported: &mut Vec<String>) {
    match ctrl {
        Control::Table(table) => {
            out.push("\u{1}tbl".to_string());
            for cell in &table.cells {
                out.push(format!("\u{1}cell {} {} {} {}", cell.row, cell.col, cell.row_span, cell.col_span));
                flatten(&cell.paragraphs, in_note, out, unsupported);
            }
            if let Some(caption) = &table.caption {
                out.push("\u{1}caption".to_string());
                flatten(&caption.paragraphs, in_note, out, unsupported);
            }
        }
        Control::Shape(shape) => flatten_shape(shape, in_note, out, unsupported),
        Control::Picture(picture) => {
            out.push("\u{1}pic".to_string());
            if let Some(caption) = &picture.caption {
                out.push("\u{1}caption".to_string());
                flatten(&caption.paragraphs, in_note, out, unsupported);
            }
        }
        Control::Equation(_) => unsupported.push("equation".to_string()),
        Control::Header(_) | Control::Footer(_) | Control::Footnote(_) | Control::Endnote(_) => {
            if in_note {
                unsupported.push("note inside note".to_string());
            } else {
                // 본문·셀 안의 주석은 walk가 따로 항목으로 낸다. 여기서는 자리만 남긴다.
                out.push("\u{1}note".to_string());
            }
        }
        _ => out.push("\u{1}ctrl".to_string()),
    }
}

/// 그리기 개체 하나를 편다. 묶음은 자식마다 다시 들어간다(몇 겹이든). 글상자·캡션은 `drawing()`에서,
/// 그림 캡션은 그림에서 읽는다(`src/model/shape.rs:430-440,715-724`, `src/model/image.rs:44`).
fn flatten_shape(shape: &ShapeObject, in_note: bool, out: &mut Vec<String>, unsupported: &mut Vec<String>) {
    match shape {
        ShapeObject::Group(group) => {
            out.push(format!("\u{1}group {}", group.children.len()));
            for child in &group.children {
                flatten_shape(child, in_note, out, unsupported);
            }
            if let Some(caption) = &group.caption {
                out.push("\u{1}caption".to_string());
                flatten(&caption.paragraphs, in_note, out, unsupported);
            }
        }
        ShapeObject::Picture(picture) => {
            out.push("\u{1}pic".to_string());
            if let Some(caption) = &picture.caption {
                out.push("\u{1}caption".to_string());
                flatten(&caption.paragraphs, in_note, out, unsupported);
            }
        }
        other => {
            out.push("\u{1}shape".to_string());
            if let Some(drawing) = other.drawing() {
                if let Some(text_box) = &drawing.text_box {
                    out.push("\u{1}textbox".to_string());
                    flatten(&text_box.paragraphs, in_note, out, unsupported);
                }
                if let Some(caption) = &drawing.caption {
                    out.push("\u{1}caption".to_string());
                    flatten(&caption.paragraphs, in_note, out, unsupported);
                }
            }
        }
    }
}

/// 개체 트리 안의 모든 글상자 문단 묶음(묶음 자식 포함). walk가 그 안의 각주·중첩 표를 찾으러 들어간다.
fn shape_text_boxes<'a>(shape: &'a ShapeObject, out: &mut Vec<&'a [Paragraph]>) {
    match shape {
        ShapeObject::Group(group) => {
            for child in &group.children {
                shape_text_boxes(child, out);
            }
        }
        other => {
            if let Some(text_box) = other.drawing().and_then(|d| d.text_box.as_ref()) {
                out.push(text_box.paragraphs.as_slice());
            }
        }
    }
}

fn paras_item(kind: &str, section: usize, path: &[usize], apply_to: Option<u8>, paras: &[Paragraph], in_note: bool) -> Value {
    let mut texts = Vec::new();
    let mut unsupported = Vec::new();
    flatten(paras, in_note, &mut texts, &mut unsupported);
    json!({ "kind": kind, "section": section, "path": path, "applyTo": apply_to,
        "texts": texts, "unsupported": unsupported })
}

fn control_item(kind: &str, section: usize, path: &[usize], ctrl: &Control) -> Value {
    let mut texts = Vec::new();
    let mut unsupported = Vec::new();
    flatten_control(ctrl, false, &mut texts, &mut unsupported);
    json!({ "kind": kind, "section": section, "path": path, "applyTo": Value::Null,
        "texts": texts, "unsupported": unsupported })
}

/// 본문·셀·글상자를 문서 순서로 걷는다. path = [문단, 컨트롤, (셀 또는 0, 문단, 컨트롤)…].
fn walk(paras: &[Paragraph], section: usize, depth: usize, path: &mut Vec<usize>, items: &mut Vec<Value>) {
    for (pi, para) in paras.iter().enumerate() {
        for (ci, ctrl) in para.controls.iter().enumerate() {
            path.push(pi);
            path.push(ci);
            match ctrl {
                Control::Header(h) => items.push(paras_item("head", section, path,
                    Some(apply_code(&h.apply_to)), h.paragraphs.as_slice(), true)),
                Control::Footer(f) => items.push(paras_item("foot", section, path,
                    Some(apply_code(&f.apply_to)), f.paragraphs.as_slice(), true)),
                Control::Footnote(n) => items.push(paras_item("fn", section, path, None, n.paragraphs.as_slice(), true)),
                Control::Endnote(n) => items.push(paras_item("en", section, path, None, n.paragraphs.as_slice(), true)),
                Control::Table(table) => {
                    // 본문 표(depth 0)의 칸은 서명이 getCellInfo·getTextInCell로 읽는다. 여기서는 캡션만 낸다.
                    if depth > 0 {
                        items.push(control_item("tbl", section, path, ctrl));
                    } else if let Some(caption) = &table.caption {
                        items.push(paras_item("caption", section, path, None, caption.paragraphs.as_slice(), false));
                    }
                    for (cell_index, cell) in table.cells.iter().enumerate() {
                        path.push(cell_index);
                        walk(&cell.paragraphs, section, depth + 1, path, items);
                        path.pop();
                    }
                }
                Control::Shape(shape) => {
                    // 개체 트리 전체(묶음 자식 포함)를 한 항목으로 낸다. 글상자 안의 표·각주는 walk가 따로 찾는다.
                    items.push(control_item("shape", section, path, ctrl));
                    let mut boxes = Vec::new();
                    shape_text_boxes(shape, &mut boxes);
                    for (box_index, paragraphs) in boxes.into_iter().enumerate() {
                        path.push(box_index);
                        walk(paragraphs, section, depth + 1, path, items);
                        path.pop();
                    }
                }
                Control::Picture(picture) => {
                    if let Some(caption) = &picture.caption {
                        items.push(paras_item("caption", section, path, None, caption.paragraphs.as_slice(), false));
                    }
                }
                _ => {}
            }
            path.pop();
            path.pop();
        }
    }
}

#[wasm_bindgen]
impl HwpDocument {
    /// lidge-hwp 내용 서명용 보조 글 목록(읽기 전용).
    /// JSON `{"schemaVersion":1,"items":[{kind,section,path,applyTo,texts,unsupported}]}`.
    #[wasm_bindgen(js_name = lidgeAuxContent)]
    pub fn lidge_aux_content(&self) -> String {
        let mut items = Vec::new();
        for (section_index, section) in self.document.sections.iter().enumerate() {
            walk(&section.paragraphs, section_index, 0, &mut Vec::new(), &mut items);
        }
        json!({ "schemaVersion": 1, "items": items }).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::control::Equation;
    use crate::model::header_footer::Header;
    use crate::model::shape::{GroupShape, RectangleShape, TextBox};

    fn para(text: &str, controls: Vec<Control>) -> Paragraph {
        Paragraph { text: text.to_string(), controls, ..Default::default() }
    }
    fn text_rect(text: &str) -> ShapeObject {
        let mut rect = RectangleShape::default();
        rect.drawing.text_box = Some(TextBox { paragraphs: vec![para(text, vec![])], ..Default::default() });
        ShapeObject::Rectangle(rect)
    }
    fn group(children: Vec<ShapeObject>) -> ShapeObject {
        ShapeObject::Group(GroupShape { children, ..Default::default() })
    }
    fn items_of(body: Vec<Paragraph>) -> Vec<Value> {
        let mut items = Vec::new();
        walk(&body, 0, 0, &mut Vec::new(), &mut items);
        items
    }
    fn body_with(shape: ShapeObject) -> Vec<Paragraph> {
        vec![para("", vec![Control::Shape(Box::new(shape))])]
    }

    #[test]
    fn group_children_text_is_read_at_any_depth() {
        let items = items_of(body_with(group(vec![text_rect("묶음 안 글"), group(vec![text_rect("두 겹 안 글")])])));
        let all = serde_json::to_string(&items).unwrap();
        assert!(all.contains("묶음 안 글"), "{all}");
        assert!(all.contains("두 겹 안 글"), "{all}");
        assert!(items.iter().all(|i| i["unsupported"].as_array().unwrap().is_empty()));
    }

    #[test]
    fn group_child_text_change_changes_items() {
        assert_ne!(items_of(body_with(group(vec![text_rect("가")]))), items_of(body_with(group(vec![text_rect("나")]))));
    }

    #[test]
    fn footnote_inside_group_text_box_is_found() {
        let inner = para("각주 앞", vec![Control::Footnote(Box::new(crate::model::footnote::Footnote {
            paragraphs: vec![para("각주 글", vec![])], ..Default::default() }))]);
        let mut rect = RectangleShape::default();
        rect.drawing.text_box = Some(TextBox { paragraphs: vec![inner], ..Default::default() });
        let items = items_of(body_with(group(vec![ShapeObject::Rectangle(rect)])));
        assert!(items.iter().any(|i| i["kind"] == "fn" && i["texts"][0] == "각주 글"));
    }

    #[test]
    fn equation_in_header_is_unsupported() {
        let header = Header { paragraphs: vec![para("", vec![Control::Equation(Box::new(Equation::default()))])], ..Default::default() };
        let items = items_of(vec![para("", vec![Control::Header(Box::new(header))])]);
        assert_eq!(items[0]["kind"], "head");
        assert_eq!(items[0]["unsupported"][0], "equation");
    }
}
