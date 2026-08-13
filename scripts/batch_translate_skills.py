import json
import re
import subprocess
import os

# Paths
db_paths = {
    'main': os.path.join(os.path.dirname(os.path.abspath(__file__)), '../data/database.json'),
    'public': os.path.join(os.path.dirname(os.path.abspath(__file__)), '../public/data/database.json')
}

# Regex for Japanese Hiragana and Katakana
jp_regex = re.compile(r'[\u3040-\u309F\u30A0-\u30FF]')

def regenerate_native_database():
    """Rebuild public/data/database.json from the canonical DB via its generator."""
    generator = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'generate-native-database.mjs')
    subprocess.run(['node', generator], check=True)


def get_nested_jp_paths(val, path=[]):
    """
    Recursively find all string values containing Japanese characters.
    Returns a list of tuples: (path_list, original_text)
    """
    results = []
    if isinstance(val, str):
        if jp_regex.search(val):
            results.append((path, val))
    elif isinstance(val, dict):
        for k, v in val.items():
            results.extend(get_nested_jp_paths(v, path + [k]))
    elif isinstance(val, list):
        for i, v in enumerate(val):
            results.extend(get_nested_jp_paths(v, path + [i]))
    return results

def get_nested_value(data, path):
    """
    Retrieve a value from a nested structure based on a path list.
    """
    current = data
    for key in path:
        if isinstance(current, dict) and key in current:
            current = current[key]
        elif isinstance(current, list) and isinstance(key, int) and 0 <= key < len(current):
            current = current[key]
        else:
            return None
    return current

def set_nested_value(data, path, new_value):
    """
    Update a value in a nested structure based on a path list.
    """
    current = data
    for key in path[:-1]:
        current = current[key]
    current[path[-1]] = new_value

def translate_text(text):
    """
    Call agy CLI to translate Japanese text to Traditional Chinese.
    """
    prompt = (
        f"請將下列日文技能說明翻譯成繁體中文（台灣用語）：\n"
        f"\"{text}\"\n\n"
        f"翻譯品質要求：\n"
        f"- 繁體中文（使用台灣用語）\n"
        f"- 保留技能名稱語感（不要過度口語化）\n"
        f"- 技能數值與符號結構保留原樣（例如 +3000 パワー 翻譯成 +3000 能量）\n"
        f"- 固定對照：ホロメン->成員，アーツ->招式，エール->應援，ダウン->倒下，コラボ->協力，ブルーム->綻放，センター->中央，バック->後方，ライフ->生命，ダメージ->傷害\n"
        f"請只輸出翻譯後的繁體中文，不要有任何其他解釋、引號或標記。"
    )
    
    try:
        # Resolve the absolute path to agy
        agy_path = os.path.expanduser('~/.local/bin/agy')
        if not os.path.exists(agy_path):
            agy_path = 'agy'
            
        res = subprocess.run([agy_path, '--model', 'gemini-3.5-flash-medium', '-p', prompt], capture_output=True, text=True, encoding='utf-8')
        if res.returncode == 0:
            translated = res.stdout.strip()
            # Clean up any potential surrounding quotes the LLM might have output
            if (translated.startswith('"') and translated.endswith('"')) or (translated.startswith('「') and translated.endswith('」')):
                translated = translated[1:-1]
            return translated
        else:
            print(f"Error calling agy: {res.stderr}")
            return None
    except Exception as e:
        print(f"Exception during translation: {e}")
        return None

def main():
    databases = {}
    for name, path in db_paths.items():
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                databases[name] = json.load(f)
            print(f"Loaded {name} database from: {path}")
        else:
            print(f"Database file ({name}) not found at: {path}")

    main_updated = False

    # 1. Process Main Database
    if 'main' in databases:
        main_db = databases['main']
        main_cards = main_db.get('cards', {})
        print(f"\nScanning main database ({len(main_cards)} cards) for Japanese in skillsZh...")
        
        # We can look up translations from public if it happens to have cached translations
        public_db = databases.get('public')
        public_cards = public_db.get('cards', {}) if public_db else {}

        to_translate = []
        for cid, card in main_cards.items():
            skills_zh = card.get('skillsZh')
            if skills_zh:
                jp_fields = get_nested_jp_paths(skills_zh)
                if jp_fields:
                    to_translate.append((cid, card.get('cardNumber'), jp_fields))

        print(f"Found {len(to_translate)} cards with Japanese in skillsZh in main database.")

        # Check nameZh for Japanese
        for cid, card in main_cards.items():
            name_zh = card.get('nameZh')
            if name_zh and jp_regex.search(name_zh):
                # Translate via agy or lookup
                other_card = public_cards.get(cid)
                other_name_zh = other_card.get('nameZh') if other_card else None
                if other_name_zh and not jp_regex.search(other_name_zh):
                    card['nameZh'] = other_name_zh
                    main_updated = True
                else:
                    translated = translate_text(name_zh)
                    if translated:
                        card['nameZh'] = translated
                        main_updated = True

        # Translate skillsZh fields
        for cid, card_num, jp_fields in to_translate:
            print(f"Card ID: {cid} (Card Number: {card_num})")
            for path, orig_text in jp_fields:
                path_str = ".".join(str(p) for p in path)
                print(f"  Path: skillsZh.{path_str}")
                print(f"  Original: {orig_text}")
                
                # Check public database first
                other_card = public_cards.get(cid)
                other_skills_zh = other_card.get('skillsZh') if other_card else None
                cached_val = get_nested_value(other_skills_zh, path) if other_skills_zh else None
                
                if cached_val and isinstance(cached_val, str) and not jp_regex.search(cached_val):
                    print(f"  Found cached translation: {cached_val}")
                    set_nested_value(main_cards[cid]['skillsZh'], path, cached_val)
                    main_updated = True
                else:
                    translated = translate_text(orig_text)
                    if translated:
                        print(f"  Translated: {translated}")
                        set_nested_value(main_cards[cid]['skillsZh'], path, translated)
                        main_updated = True
                    else:
                        print("  Failed to translate.")

        if main_updated:
            main_db['cards'] = main_cards
            with open(db_paths['main'], 'w', encoding='utf-8') as f:
                json.dump(main_db, f, indent=2, ensure_ascii=False)
                f.write('\n')
            print(f"Successfully updated main database at {db_paths['main']}.")
        else:
            print("No translations were performed for main database.")

    # 2. Rebuild the public database.
    #    public/data/database.json is a GENERATED asset — exactly
    #    sanitizeDatabase(data/database.json), serialized compactly by
    #    generate-native-database.mjs (DIC-916). It used to be hand-written here with
    #    indent=2, which produced bytes the --check gate rejects and let it drift from
    #    canonical. Deriving it from the final canonical bytes propagates the
    #    translations above and keeps the two files in lockstep (DIC-989).
    regenerate_native_database()

if __name__ == '__main__':
    main()
