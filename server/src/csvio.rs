//! CSV round-trip for spreadsheet-style mass edits: export, edit columns, import (upsert by id).

use serde_json::{json, Value};

use crate::model::{field, is_system, schema, FType, Kind, Rec};

// reqforge: implements REQ-0008
pub fn export(records: &[std::sync::Arc<Rec>], kind: Kind) -> String {
    let mut cols: Vec<&str> = vec!["id"];
    cols.extend(schema(kind).iter().map(|f| f.name));
    cols.push("version");
    let mut w = csv::WriterBuilder::new().terminator(csv::Terminator::CRLF).from_writer(vec![]);
    w.write_record(&cols).ok();
    for r in records {
        let row: Vec<String> = cols
            .iter()
            .map(|c| {
                let v = r.get(*c);
                let objlist = field(kind, c).map(|f| f.ftype == FType::ObjList).unwrap_or(false);
                match v {
                    _ if objlist => serde_json::to_string(v.unwrap_or(&json!([]))).unwrap_or_default(),
                    Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect::<Vec<_>>().join(", "),
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Null) | None => String::new(),
                    Some(other) => other.to_string(),
                }
            })
            .collect();
        w.write_record(&row).ok();
    }
    String::from_utf8(w.into_inner().unwrap_or_default()).unwrap_or_default()
}

// reqforge: implements REQ-0008
pub fn parse(text: &str, kind: Kind) -> Result<Vec<Rec>, String> {
    let mut rdr = csv::ReaderBuilder::new().flexible(true).from_reader(text.as_bytes());
    let headers = rdr.headers().map_err(|e| e.to_string())?.clone();
    let mut rows = vec![];
    for rec in rdr.records() {
        let rec = rec.map_err(|e| e.to_string())?;
        let mut row = Rec::new();
        for (h, v) in headers.iter().zip(rec.iter()) {
            let v = v.trim();
            if h == "id" {
                if !v.is_empty() {
                    row.insert("id".into(), json!(v));
                }
                continue;
            }
            if is_system(h) {
                continue;
            }
            let Some(spec) = field(kind, h) else { continue };
            if v.is_empty() && !spec.ftype.is_list() {
                continue; // blank cell = leave unchanged
            }
            let val = if spec.ftype == FType::ObjList {
                serde_json::from_str(if v.is_empty() { "[]" } else { v }).map_err(|e| format!("{h}: {e}"))?
            } else {
                json!(v)
            };
            row.insert(h.into(), val);
        }
        rows.push(row);
    }
    Ok(rows)
}
