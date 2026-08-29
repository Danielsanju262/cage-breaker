import re, sys, os

# Automatically locate root directory regardless of invocation path
script_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = script_dir if os.path.exists(os.path.join(script_dir, 'index.html')) else os.path.dirname(script_dir)

target_files = [os.path.join(root_dir, f) for f in ['index.html', 'cage-breaker.html']]

for filepath in target_files:
    fname = os.path.basename(filepath)
    if not os.path.exists(filepath):
        print(f'{fname}: File not found at {filepath}')
        continue
    with open(filepath, encoding='utf-8') as f:
        html = f.read()
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
            
            # Handle line comments and block comments
            if not in_str and ch == '/' and i+1 < len(line):
                if line[i+1] == '/':
                    break
                elif line[i+1] == '*':
                    # Simple inline block comment skip
                    end_bc = line.find('*/', i+2)
                    if end_bc != -1:
                        i = end_bc + 2
                        continue

            # Handle regex literals (e.g. /[abc]/g after (, =, :, ,, [, !, return, etc.)
            if not in_str and ch == '/':
                # Check if preceding non-whitespace character indicates a regex literal context
                prev_text = line[:i].rstrip()
                if not prev_text or prev_text[-1] in '=(:[,!&|?{};+~':
                    # Parse until end of regex literal
                    r_idx = i + 1
                    in_char_class = False
                    r_escape = False
                    found_end = False
                    while r_idx < len(line):
                        r_ch = line[r_idx]
                        if r_escape:
                            r_escape = False
                            r_idx += 1
                            continue
                        if r_ch == '\\':
                            r_escape = True
                            r_idx += 1
                            continue
                        if r_ch == '[' and not in_char_class:
                            in_char_class = True
                        elif r_ch == ']' and in_char_class:
                            in_char_class = False
                        elif r_ch == '/' and not in_char_class:
                            found_end = True
                            r_idx += 1
                            # consume flags
                            while r_idx < len(line) and line[r_idx].isalpha():
                                r_idx += 1
                            break
                        r_idx += 1
                    if found_end:
                        i = r_idx
                        continue
            
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
