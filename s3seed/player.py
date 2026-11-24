"""The player's Splatoon name, out of the save in RAM beside the drink field.

Found on Splatoon 3 v12.0.0 (2026-11-22): the name is a MessagePack string under the field hash ce 45 40 50 8d (a fixstr 0xa0+len
or a str8 0xd9 len, UTF-8), 0x23D bytes before the drink field in the same save copy. The same key shows up again ~0x6700 later
for the OTHER players (recent players), so name_near() takes the last one before the drink field, within WINDOW bytes.
"""
from .botbase import Botbase, BotbaseError

NAME = bytes.fromhex("ce4540508d")
WINDOW = 0x400                   # one read ending at the drink field


def decode(data: bytes) -> str | None:
    """The name under the last NAME key in data whose string ends inside data; None when there isn't one."""
    i = data.rfind(NAME)
    while i >= 0:
        j = i + len(NAME)
        if j < len(data):
            t = data[j]
            if 0xA0 <= t <= 0xBF:
                a, n = j + 1, t - 0xA0
            elif t == 0xD9 and j + 1 < len(data):
                a, n = j + 2, data[j + 1]
            else:
                a, n = 0, 0
            if n and a + n <= len(data):
                try:
                    return data[a:a + n].decode("utf-8")
                except UnicodeDecodeError:
                    pass
        i = data.rfind(NAME, 0, i)
    return None


def name_near(bot: Botbase, drink_at: int) -> str | None:
    """The player's name in one read of WINDOW bytes ending at the drink field's hash; None when it isn't there."""
    try:
        return decode(bot.peek(drink_at - WINDOW, WINDOW))
    except BotbaseError:
        return None
