"""
check_sites.py
ដំណើរការស្វ័យប្រវត្តិ៖ ផ្ញើ /bts CHA0001 ... CHA0500 ទៅ Bot B ម្តងមួយៗតាមរយៈគណនី Telegram
ផ្ទាល់ខ្លួន (userbot) រួចកត់ត្រាលទ្ធផលទៅ Google Sheet។ រត់ដោយ GitHub Actions តាមកាលវិភាគ។
"""

import os
import time
import json
import random
from datetime import datetime

from telethon.sync import TelegramClient
from telethon.sessions import StringSession
from telethon.errors import FloodWaitError

import gspread
from google.oauth2.service_account import Credentials

# ============================================================
# CONFIG - តម្លៃភាគច្រើនមកពី GitHub Secrets (environment variables)
# ============================================================
API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
SESSION_STRING = os.environ["TELEGRAM_SESSION"]
BOT_USERNAME = os.environ["BOT_USERNAME"]          # ឈ្មោះ Bot B ដោយគ្មាន @ ឧ. "SomeStatusBot"
SPREADSHEET_ID = os.environ["SPREADSHEET_ID"]
GOOGLE_CREDS_JSON = os.environ["GCP_SA_KEY"]  # Service account JSON ទាំងមូល (គ្មាន encode)
NOTIFY_GROUP_ID = os.environ["NOTIFY_GROUP_ID"]  # Chat ID របស់ក្រុមដែលត្រូវផ្ញើសារ Offline notification ទៅ

CHECK_COMMAND = "/bts"
SHEET_QUEUE = "Queue"
SHEET_OFFLINE = "OfflineSites"
SHEET_OWNERS = "SiteOwners"
NO_FAULT_TEXT = "No data available"  # មានន័យថាគ្មាន fault ត្រូវបានរកឃើញ - site កំពុង Online
CHECKING_TEXT = "Checking system"  # សារបណ្តោះអាសន្នពី Bot B មុននឹងឆ្លើយចម្លើយពិត - ត្រូវរំលងវាចោល
REPLY_TIMEOUT_SEC = 120    # រង់ចាំចម្លើយប៉ុន្មានវិនាទីមុននឹងចាត់ទុកថាគ្មានចម្លើយ (Bot B អាចយឺត ១-២ នាទី ព្រោះមានគេសួរដែរក្នុងគ្រុប)
POLL_INTERVAL_SEC = 4      # ញែកមើលចម្លើយរៀងរាល់ប៉ុន្មានវិនាទី
DELAY_BETWEEN_SITES_SEC = 10  # ចន្លោះពេលមូលដ្ឋានរវាងសំណួរនីមួយៗ (បន្ថែម jitter ចៃដន្យទៀត ដើម្បីកុំឲ្យមើលទៅដូច bot ពេក)
DELAY_JITTER_SEC = 4          # បន្ថែមចន្លោះចៃដន្យ 0-5 វិនាទីទៀតលើ delay មូលដ្ឋាន


# ============================================================
# Google Sheets helpers
# ============================================================
def get_spreadsheet():
    creds_dict = json.loads(GOOGLE_CREDS_JSON)
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_info(creds_dict, scopes=scopes)
    gc = gspread.authorize(creds)
    return gc.open_by_key(SPREADSHEET_ID)


def get_or_create_worksheet(sh, title, header):
    try:
        ws = sh.worksheet(title)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title=title, rows=1000, cols=len(header))
        ws.append_row(header)
    return ws


def load_queue(sh):
    """អាន site code ពីជួរឈរ A របស់ Sheet 'Queue' (ជួរដេកទី 2 ចុះក្រោម)។
    ត្រូវការឲ្យអ្នកប្រើ paste កូដ (មួយកូដក្នុងមួយជួរដេក) ចូលជួរឈរ A ដោយផ្ទាល់ជាមុន។"""
    ws = get_or_create_worksheet(sh, SHEET_QUEUE, ["Code", "Status", "Result", "CheckedAt"])
    rows = ws.get_all_values()
    codes = []
    for row_num, row in enumerate(rows[1:], start=2):  # រំលងបន្ទាត់ header
        if row and row[0].strip():
            codes.append((row_num, row[0].strip()))
    return ws, codes


def load_owners(sh):
    """អាន Sheet 'SiteOwners' (Code | Mether | Staff) - ត្រឡប់ dict: code -> (mether_username, staff_username)"""
    try:
        ws = sh.worksheet(SHEET_OWNERS)
    except gspread.WorksheetNotFound:
        return {}
    owners = {}
    for row in ws.get_all_values()[1:]:  # រំលងបន្ទាត់ header
        if row and row[0].strip():
            code = row[0].strip()
            mether = row[1].strip() if len(row) > 1 else ""
            staff = row[2].strip() if len(row) > 2 else ""
            owners[code] = (mether, staff)
    return owners


# ============================================================
# Telegram helpers
# ============================================================
def wait_for_reply(client, entity, sent_message):
    """ត្រួតពិនិត្យរកមើលសារថ្មីដែលចូលមកបន្ទាប់ពីសារយើងផ្ញើ (min_id) រហូតដល់ REPLY_TIMEOUT_SEC។
    រំលងសារបណ្តោះអាសន្ន "Checking system..." ចោល រង់ចាំចម្លើយពិតប្រាកដទើបចាត់ទុកជាបញ្ចប់។"""
    deadline = time.time() + REPLY_TIMEOUT_SEC
    while time.time() < deadline:
        for m in client.get_messages(entity, min_id=sent_message.id, limit=10):
            if m.out:
                continue  # សារយើងផ្ញើផ្ទាល់ - រំលង
            text = m.text or ""
            if CHECKING_TEXT in text:
                continue  # សារបណ្តោះអាសន្ន - នៅតែត្រូវរង់ចាំចម្លើយពិត
            return text
        time.sleep(POLL_INTERVAL_SEC)
    return None


# ============================================================
# Main
# ============================================================
def main():
    sh = get_spreadsheet()
    queue_ws, codes = load_queue(sh)
    offline_ws = get_or_create_worksheet(sh, SHEET_OFFLINE, ["Code", "Reason", "CheckedAt"])
    owners = load_owners(sh)

    if not codes:
        print("Queue sheet ទទេ - សូម paste site code ចូលជួរឈរ A សិន (ចាប់ពីជួរដេកទី 2)")
        return

    # សម្អាតលទ្ធផលពីលើកមុនចោល ដើម្បីចាប់ផ្តើមថ្ងៃថ្មីស្អាត (ជួរឈរ A ដែលមានកូដមិនប៉ះពាល់ទេ)
    last_row = codes[-1][0]
    queue_ws.batch_clear([f"B2:D{last_row}"])
    offline_ws.batch_clear([f"A2:C{max(offline_ws.row_count, last_row)}"])

    online = offline = no_resp = 0

    with TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH) as client:
        entity = client.get_entity(BOT_USERNAME)

        for row_num, code in codes:
            try:
                sent = client.send_message(entity, f"{CHECK_COMMAND} {code}")
                reply_text = wait_for_reply(client, entity, sent)
                now = datetime.now().isoformat()

                if reply_text is None:
                    result = "NoResponse"
                    no_resp += 1
                    offline_ws.append_row([code, "NoResponse", now])
                elif NO_FAULT_TEXT.lower() in reply_text.lower():
                    result = "Online"
                    online += 1
                else:
                    # មានទិន្នន័យ fault ត្រឡប់មក (ឧ. Genset/DC Monitoring System Disconnected) - មានន័យថា Offline
                    result = "Offline"
                    offline += 1
                    reason = reply_text.strip()[:200]
                    offline_ws.append_row([code, reason, now])

                    mether, staff = owners.get(code, ("", ""))
                    notify_lines = [f"⚠️ Site {code} Offline", f"មូលហេតុ: {reason}"]
                    if mether:
                        notify_lines.append(f"មេទីម: {mether}")
                    if staff:
                        notify_lines.append(f"បុគ្គលិកគ្រប់គ្រង: {staff}")
                    client.send_message(NOTIFY_GROUP_ID, "\n".join(notify_lines))

                queue_ws.update(range_name=f"B{row_num}:D{row_num}", values=[["Done", result, now]])
                print(f"{code}: {result}")

            except FloodWaitError as e:
                # Telegram ប្រាប់ថាយើងសួរញឹកញាប់ពេក - ត្រូវរង់ចាំតាមចំនួនវិនាទីដែលវាកំណត់ រួចសាកល្បង site នេះម្តងទៀត
                wait_sec = e.seconds + 5
                print(f"{code}: FloodWait - រង់ចាំ {wait_sec} វិនាទី")
                queue_ws.update(range_name=f"B{row_num}:D{row_num}", values=[["Error", f"FloodWait {e.seconds}s", datetime.now().isoformat()]])
                time.sleep(wait_sec)
                continue

            except Exception as e:
                # error ផ្សេងទៀតពី Bot B (ឬបញ្ហា network) - កត់ត្រាទុក ហើយបន្តទៅ site បន្ទាប់ មិនបញ្ឈប់ទាំង run ទេ
                print(f"{code}: Error - {e}")
                queue_ws.update(range_name=f"B{row_num}:D{row_num}", values=[["Error", str(e)[:200], datetime.now().isoformat()]])

            time.sleep(DELAY_BETWEEN_SITES_SEC + random.uniform(0, DELAY_JITTER_SEC))

    print(f"\nរួចរាល់! Online={online}  Offline={offline}  NoResponse={no_resp}")


if __name__ == "__main__":
    main()
