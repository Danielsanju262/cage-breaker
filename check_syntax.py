import re, sys

for fname in ['index.html', 'cage-breaker.html']:
    html = open(fname, encoding='utf-8').read()
    m = re.search(r'<script>(.*?)</script>', html, re.DOTALL)
    if not m:
        print(f'{fname}: No script tag found!')
        continue
    code = m.group(1)
    lines = code.split('\n')
    stack = []
    in_str = None
    escape = False
    in_template = 0
    
    for lnum, line in enumerate(lines, 1):
        i = 0
        while i < len(line):
            ch = line[i]
            
            # Handle escape
            if escape:
                escape = False
                i += 1
                continue
            if ch == '\\':
                escape = True
                i += 1
                continue
            
            # Handle line comments
            if not in_str and ch == '/' and i+1 < len(line) and line[i+1] == '/':
                break
            
            # Handle strings
            if ch == '`':
                if in_str == '`':
                    in_str = None
                    in_template -= 1
                elif not in_str:
                    in_str = '`'
                    in_template += 1
                i += 1
                continue
            
            if ch in ('"', "'"):
                if in_str == ch:
                    in_str = None
                elif not in_str:
                    in_str = ch
                i += 1
                continue
            
            # In template literal, handle ${
            if in_str == '`' and ch == '$' and i+1 < len(line) and line[i+1] == '{':
                stack.append(('{', lnum))
                i += 2
                continue
            
            # Skip if inside a non-template string
            if in_str and in_str != '`':
                i += 1
                continue
            
            # Handle brackets (but only outside of strings, or inside ${} in templates)
            if ch in '({[':
                stack.append((ch, lnum))
            elif ch in ')}]':
                expected = {'(': ')', '{': '}', '[': ']'}
                if not stack:
                    print(f'{fname}: Unmatched closing {ch} at script line {lnum}')
                    print(f'  Line content: {line.strip()[:120]}')
                else:
                    open_ch, open_lnum = stack[-1]
                    if expected.get(open_ch) == ch:
                        stack.pop()
                    else:
                        print(f'{fname}: Mismatch: opened {open_ch} at line {open_lnum}, closed {ch} at line {lnum}')
                        print(f'  Line content: {line.strip()[:120]}')
            i += 1
    
    if stack:
        print(f'{fname}: UNCLOSED brackets at end:')
        for ch, ln in stack[-5:]:
            print(f'  {ch} opened at script line {ln}: {lines[ln-1].strip()[:120]}')
    else:
        print(f'{fname}: Bracket check OK!')
