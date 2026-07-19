import json
import re
import subprocess
import os

# Paths
db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../data/database.json')

# Regex for Japanese Hiragana and Katakana
jp_regex = re.compile(r'[\u3040-\u309F\u30A0-\u30FF]')

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
            
        res = subprocess.run([agy_path, '-p', prompt], capture_output=True, text=True, encoding='utf-8')
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
    if not os.path.exists(db_path):
        print(f"Database file not found at: {db_path}")
        return

    with open(db_path, 'r', encoding='utf-8') as f:
        db = json.load(f)

    cards = db.get('cards', {})
    print(f"Loaded database.json. Scanning {len(cards)} cards for Japanese in skillsZh...")

    # Step 1: Scan all cards
    to_translate = []
    for cid, card in cards.items():
        skills_zh = card.get('skillsZh')
        if skills_zh:
            jp_fields = get_nested_jp_paths(skills_zh)
            if jp_fields:
                to_translate.append((cid, card.get('cardNumber'), jp_fields))

    print(f"Found {len(to_translate)} cards with Japanese in skillsZh.")

    # Step 2 & 3: Translate and update
    translated_count = 0
    for cid, card_num, jp_fields in to_translate:
        print(f"\nCard ID: {cid} (Card Number: {card_num})")
        for path, orig_text in jp_fields:
            path_str = ".".join(str(p) for p in path)
            print(f"  Path: skillsZh.{path_str}")
            print(f"  Original: {orig_text}")
            
            translated = translate_text(orig_text)
            if translated:
                print(f"  Translated: {translated}")
                set_nested_value(cards[cid]['skillsZh'], path, translated)
                translated_count += 1
            else:
                print("  Failed to translate.")

    if translated_count > 0:
        # Write back to database.json
        db['cards'] = cards
        with open(db_path, 'w', encoding='utf-8') as f:
            json.dump(db, f, indent=2, ensure_ascii=False)
        print(f"\nSuccessfully translated and updated {translated_count} fields in database.json.")
    else:
        print("\nNo translations were needed or performed.")

if __name__ == '__main__':
    main()
