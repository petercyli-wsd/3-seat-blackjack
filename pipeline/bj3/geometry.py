"""Fixed table geometry in source pixels (1440x810, locked-off camera).

Seats are named by their position on screen. Seat 1 is the left box, seat 3
the right box; the dealer deals and plays them right to left (seat 3 first),
which is how the take was filmed — the dealer's left is first base.

These boxes are generous search windows. The exact per-seat compositing
masks are derived from the settled card pixels in `plates.py`.
"""

REGIONS = {
    "seat1": (632, 455, 756, 540),
    "seat2": (756, 432, 852, 548),
    "seat3": (852, 412, 930, 538),
    "up": (731, 370, 762, 397),
    "hole": (762, 370, 794, 397),
}

SEATS = ("seat1", "seat2", "seat3")
PLAY_ORDER = ("seat3", "seat2", "seat1")
