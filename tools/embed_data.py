import json
import re

def process_file(html_file, master_data):
    with open(html_file, 'r', encoding='utf-8') as f:
        content = f.read()

    json_str = json.dumps(master_data, ensure_ascii=False)
    # Prevent </script> tag break out
    json_str = json_str.replace('</script>', '<\\/script>')

    embedded_js = '    const EMBEDDED_INITIAL_DATA = ' + json_str + ';\n'
    target = '    const DEF = { screen: "hub", identities: [], creating: null, currentId: null, deletedIds: [] };'

    if 'const EMBEDDED_INITIAL_DATA =' in content:
        # Use lambda in re.sub to prevent backslash expansion (e.g. \\n becoming literal newline)
        content = re.sub(r'    const EMBEDDED_INITIAL_DATA = .*?;\n', lambda m: embedded_js, content)
    else:
        content = content.replace(target, embedded_js + target)

    with open(html_file, 'w', encoding='utf-8') as f:
        f.write(content)

    print(f'Embedded initial data written successfully to {html_file}!')

if __name__ == '__main__':
    with open('combined_master_backup.json', 'r', encoding='utf-8') as f:
        master_data = json.load(f)

    process_file('index.html', master_data)
    process_file('cage-breaker.html', master_data)

