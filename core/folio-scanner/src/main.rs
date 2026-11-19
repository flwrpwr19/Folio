use std::env;
use std::path::PathBuf;

use folio_scanner::scan;

fn main() {
    let Some(root) = env::args().nth(1) else {
        eprintln!("usage: folio-scanner <folder>");
        std::process::exit(2);
    };

    let root = PathBuf::from(root);
    if !root.is_dir() {
        eprintln!("not a folder: {}", root.display());
        std::process::exit(2);
    }

    let items = scan(&root);
    print_json(&root, &items);
}

fn print_json(root: &PathBuf, items: &[folio_scanner::MediaEntry]) {
    print!("{{\"root\":\"{}\",\"count\":{},\"items\":[", escape_json(&root.display().to_string()), items.len());
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            print!(",");
        }
        print!(
            "{{\"path\":\"{}\",\"name\":\"{}\",\"size\":{},\"modified\":{}}}",
            escape_json(&item.path.display().to_string()),
            escape_json(&item.name),
            item.size,
            item.modified
        );
    }
    println!("]}}");
}

fn escape_json(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character.is_control() => {
                output.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => output.push(character),
        }
    }
    output
}
