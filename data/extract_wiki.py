import xml.etree.ElementTree as ET
import json
import re
import sys
import html

def remove_balanced(text, open_marker, close_marker):
    """
    Removes all content contained within balanced markers, including the markers.
    Handles nesting by tracking depth.
    """
    if not text:
        return ""
        
    result = []
    current_pos = 0
    depth = 0
    
    while current_pos < len(text):
        next_open = text.find(open_marker, current_pos)
        next_close = text.find(close_marker, current_pos)
        
        if next_open == -1 and next_close == -1:
            if depth == 0:
                result.append(text[current_pos:])
            break
            
        if next_open != -1 and (next_close == -1 or next_open < next_close):
            if depth == 0:
                result.append(text[current_pos:next_open])
            depth += 1
            current_pos = next_open + len(open_marker)
        else:
            if depth > 0:
                depth -= 1
            elif depth == 0:
                result.append(text[current_pos:next_close + len(close_marker)])
            current_pos = next_close + len(close_marker)
            
    return "".join(result)

def clean_wikitext(text):
    if not text:
        return ""
    
    # 1. Remove comments
    text = re.sub(r'', '', text, flags=re.DOTALL)
    
    # 2. Remove references
    text = re.sub(r'<ref[^>]*>.*?</ref>', '', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<ref[^>]*?/>', '', text, flags=re.IGNORECASE)
    
    # 3. Remove Tables and Templates
    text = remove_balanced(text, '{|', '|}')
    text = remove_balanced(text, '{{', '}}')
    
    # 4. Handle Links [[Target|Label]] -> Label
    link_pattern = re.compile(r'\[\[([^\[\]]*)\]\]')
    while True:
        def replace_link(match):
            content = match.group(1)
            if '|' in content:
                parts = content.split('|')
                target = parts[0].strip().lower()
                if target.startswith('file:') or target.startswith('image:') or target.startswith('category:'):
                    return "" 
                return parts[-1]
            else:
                target = content.strip().lower()
                if target.startswith('file:') or target.startswith('image:') or target.startswith('category:'):
                    return ""
                return content

        new_text, count = link_pattern.subn(replace_link, text)
        if count == 0:
            break
        text = new_text

    # 5. Remove HTML tags
    text = re.sub(r'</?[a-zA-Z][^>]*>', '', text)
    
    # 6. Decode HTML entities
    text = html.unescape(text)

    # 7. Remove bold/italic formatting
    text = re.sub(r"''+", '', text)
    
    # 8. Clean up broken parentheses
    text = re.sub(r'\(\s*\)', '', text)
    
    # 9. Cleanup whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    
    # 10. Advanced Punctuation Cleanup
    
    # Remove leading punctuation often left by removed templates.
    # We remove , ; : ) but preserve - (for suffixes like -logy)
    text = re.sub(r'^[\s,;:\)]+', '', text)
    # Remove leading hyphen only if it looks like a bullet point (followed by space)
    text = re.sub(r'^-\s+', '', text)
    
    # Fix " ," " ;" -> ", " "; "
    text = re.sub(r'\s+([,;:?!])', r'\1', text)
    
    # Fix " ." -> "." ONLY if not followed by a letter/number (to protect .NET, .bss)
    # This matches "word . Next" -> "word. Next"
    # But "The .NET" -> "The .NET"
    text = re.sub(r'\s+\.(?![a-zA-Z0-9])', '.', text)
    
    # Fix double punctuation
    text = re.sub(r',,+', ',', text)
    text = re.sub(r';;+', ';', text)
    
    # Cleanup empty parens again
    text = re.sub(r'\(\s*[;,\s]*\)', '', text)
    
    return text.strip()

def extract_intro(text):
    if not text:
        return ""
    # Find the first section header (== Header ==)
    match = re.search(r'^==', text, flags=re.MULTILINE)
    raw_intro = text
    if match:
        raw_intro = text[:match.start()]
    
    return clean_wikitext(raw_intro)

def process_wiki_dump(filepath):
    context = ET.iterparse(filepath, events=('end',))
    current_page = {}
    
    for event, elem in context:
        tag = elem.tag.split('}')[-1]
        
        if tag == 'page':
            intro_text = extract_intro(current_page.get('text'))
            
            if intro_text:
                page_data = {
                    'id': current_page.get('id'),
                    'title': current_page.get('title'),
                    'intro': intro_text
                }
                try:
                    print(json.dumps(page_data))
                    sys.stdout.flush()
                except BrokenPipeError:
                    sys.stdout = None
                    sys.exit(0)
            
            current_page = {}
            elem.clear()
            
        elif tag == 'title':
            current_page['title'] = elem.text
        elif tag == 'id' and 'id' not in current_page:
            current_page['id'] = elem.text
        elif tag == 'text':
            current_page['text'] = elem.text

if __name__ == "__main__":
    filename = sys.argv[1] if len(sys.argv) > 1 else "Wikipedia-20260201073551.xml"
    try:
        process_wiki_dump(filename)
    except FileNotFoundError:
        print(f"Error: File '{filename}' not found.", file=sys.stderr)

