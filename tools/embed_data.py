import json

with open('combined_master_backup.json', 'r', encoding='utf-8') as f:
    master_data = json.load(f)

with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

embedded_js = '    const EMBEDDED_INITIAL_DATA = ' + json.dumps(master_data, ensure_ascii=False) + ';\n'

target = '    const DEF = { screen: "hub", identities: [], creating: null, currentId: null, deletedIds: [] };'

if 'const EMBEDDED_INITIAL_DATA =' in content:
    import re
    content = re.sub(r'    const EMBEDDED_INITIAL_DATA = .*?;\n', embedded_js, content, flags=re.DOTALL)
else:
    content = content.replace(target, embedded_js + target)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(content)

print('Embedded initial data written successfully!')
