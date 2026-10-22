"""Pico RGB Keypad firmware. The code lives in lib/rgbkeypad; see README.md."""

try:
    from rgbkeypad.app import main

    main()
except Exception as error:  # Ctrl-C (KeyboardInterrupt) still drops to the REPL
    import traceback

    traceback.print_exception(error)
    from rgbkeypad.recovery import run

    run(error)
